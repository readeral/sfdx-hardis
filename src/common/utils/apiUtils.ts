import { uxLog } from ".";
import * as c from "chalk";
import { Connection, SfdxError } from "@salesforce/core";
import { RestApiOptions, RecordResult } from "jsforce";
import * as ora from "ora";

// Perform simple SOQL query (max results: 10000)
export function soqlQuery(soqlQuery: string, conn: Connection): Promise<any> {
  uxLog(this, c.grey("SOQL REST: " + c.italic(soqlQuery.length > 500 ? soqlQuery.substr(0, 500) + "..." : soqlQuery) + " on " + conn.instanceUrl));
  return conn.query(soqlQuery);
}

// Perform simple SOQL query with Tooling API
export function soqlQueryTooling(soqlQuery: string, conn: Connection): Promise<any> {
  uxLog(
    this,
    c.grey("SOQL REST Tooling: " + c.italic(soqlQuery.length > 500 ? soqlQuery.substr(0, 500) + "..." : soqlQuery) + " on " + conn.instanceUrl),
  );
  return conn.tooling.query(soqlQuery);
}

let spinnerQ;
const maxRetry = Number(process.env.BULK_QUERY_RETRY || 5);
// Same than soqlQuery but using bulk. Do not use if there will be too many results for javascript to handle in memory
export async function bulkQuery(soqlQuery: string, conn: Connection, retries = 3): Promise<any> {
  uxLog(this, c.grey("SOQL BULK: " + c.italic(soqlQuery.length > 500 ? soqlQuery.substr(0, 500) + "..." : soqlQuery)));
  conn.bulk.pollInterval = 5000; // 5 sec
  conn.bulk.pollTimeout = 60000; // 60 sec
  const records = [];
  return new Promise((resolve, reject) => {
    spinnerQ = ora({ text: `Bulk query...`, spinner: "moon" }).start();
    const job = conn.bulk.query(soqlQuery);
    job
      .on("record", async (record) => {
        records.push(record);
      })
      .on("error", async (err) => {
        spinnerQ.fail(`Bulk query error.`);
        uxLog(this, c.yellow("Bulk query error: " + err));
        // In case of timeout, retry if max retry is not reached
        if ((err + "").includes("ETIMEDOUT") && retries < maxRetry) {
          uxLog(this, c.yellow("Bulk query retry attempt #" + retries + 1));
          bulkQuery(soqlQuery, conn, retries + 1)
            .then((resRetry) => {
              resolve(resRetry);
            })
            .catch((resErr) => {
              reject(resErr);
            });
        } else {
          // If max retry attempts reached, give up
          uxLog(this, c.red("Bulk query error: max retry attempts reached, or not timeout error."));
          globalThis.sfdxHardisFatalError = true;
          reject(err);
        }
      })
      .on("end", () => {
        spinnerQ.succeed(`Bulk query completed with ${records.length} results.`);
        resolve({ records: records, totalSize: records.length });
      });
  });
}

// When you might have more than 1000 elements in a IN condition, you need to split the request into several requests
// Think to use {{IN}} in soqlQuery
export async function bulkQueryChunksIn(soqlQuery: string, conn: Connection, inElements: string[], batchSize = 1000, retries = 3): Promise<any> {
  const results = { records: [] };
  for (let i = 0; i < inElements.length; i += batchSize) {
    const inElementsChunk = inElements.slice(i, i + batchSize);
    const replacementString = "'" + inElementsChunk.join("','") + "'";
    const soqlQueryWithInConstraint = soqlQuery.replace("{{IN}}", replacementString);
    const chunkResults = await bulkQuery(soqlQueryWithInConstraint, conn, retries);
    results.records.push(...chunkResults.records);
  }
  return results;
}

let spinner;
// Same than soqlQuery but using bulk. Do not use if there will be too many results for javascript to handle in memory
export async function bulkUpdate(objectName: string, action: string, records: Array<any>, conn: Connection): Promise<any> {
  uxLog(this, c.grey(`SOQL BULK on object ${c.bold(objectName)} with action ${c.bold(action)} (${c.bold(records.length)} records)`));
  conn.bulk.pollInterval = 5000; // 5 sec
  conn.bulk.pollTimeout = 60000; // 60 sec
  return new Promise((resolve, reject) => {
    const job = conn.bulk.createJob(objectName, action);
    const batch = job.createBatch();
    batch.execute(records);
    batch.on("queue", async (batchInfo) => {
      uxLog(this, c.grey("Bulk API job batch has been queued"));
      uxLog(this, c.grey(JSON.stringify(batchInfo, null, 2)));
      spinner = ora({ text: `Bulk Load on ${objectName} (${action})`, spinner: "moon" }).start();
      batch.poll(3 * 1000, 120 * 1000);
    });
    batch.on("error", (batchInfo) => {
      job.close();
      spinner.fail(`Bulk Load on ${objectName} (${action}) failed.`);
      uxLog(this, c.red("Bulk query error:" + batchInfo));
      reject(batchInfo);
      throw new SfdxError(c.red("Bulk query error:" + batchInfo));
    });
    batch.on("response", (results) => {
      job.close();
      spinner.succeed(`Bulk Load on ${objectName} (${action}) completed.`);
      resolve({
        results: results,
        totalSize: results.length,
        successRecordsNb: results.filter((result) => result.success).length,
        errorRecordsNb: results.filter((result) => !result.success).length,
      });
    });
  });
}

export async function bulkDeleteTooling(objectName: string, recordsFull: { Id: string }[], conn: Connection): Promise<any> {
  return new Promise((resolve, reject) => {
    const records = recordsFull.map((record) => record.Id);
    const options: RestApiOptions = { allOrNone: false };
    const handleCallback = (err: Error, result: RecordResult | RecordResult[]) => {
      if (err) {
        const resultObject = createResultObject(records, false, `One or more ${objectName} records failed to delete.`);
        uxLog(this, c.red(`Error deleting ${objectName} records:` + resultObject));
        reject(err);
        throw new SfdxError(c.red(`Error deleting ${objectName} records:` + resultObject));
      } else {
        const resultsArray = Array.isArray(result) ? result : [result];
        const anyFailure = resultsArray.some((result) => !result.success);

        const resultObject = createResultObject(records, !anyFailure, anyFailure ? `One or more ${objectName} records failed to delete.` : "");
        resolve(resultObject);
      }
    };
    const createResultObject = (records: string | string[], success: boolean, errorMessage: string) => {
      const recordsArray = Array.isArray(records) ? records : [records];

      return {
        results: recordsArray.map((record) => ({
          id: record,
          success: success,
          errors: success ? [] : [errorMessage],
        })),
        totalSize: recordsArray.length,
        successRecordsNb: success ? recordsArray.length : 0,
        errorRecordsNb: success ? 0 : recordsArray.length,
        errorDetails: success ? [] : [{ error: errorMessage }],
      };
    };
    try {
      conn.tooling.del(objectName, records, options, handleCallback);
    } catch (error) {
      const resultObject = createResultObject(records, false, `One or more records failed to delete due to a synchronous error.\n${error.message}`);
      reject(resultObject);
      throw new SfdxError(c.red("Tooling Error:" + resultObject));
    }
  });
}
