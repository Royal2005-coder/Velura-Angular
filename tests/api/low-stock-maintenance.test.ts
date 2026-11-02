import test from "node:test";
import assert from "node:assert/strict";
import { runLowStockAlertRetryPass } from "../../apps/api/src/products/low-stock-maintenance.js";
import type { ProductRepository } from "../../apps/api/src/products/product-repository.js";

test("scheduled low-stock retry pass reads due retries without anyone opening the list", async () => {
  let listed = 0;
  const repository = {
    listDueLowStockAlertRetries: async (limit: number) => { listed = limit; return []; },
    completeLowStockAlertRetry: async () => undefined,
    recordLowStockAlertFailure: async () => true
  } as unknown as ProductRepository;
  await runLowStockAlertRetryPass(repository);
  assert.equal(listed, 5);
});

test("scheduled retry pass never throws when the repository fails", async () => {
  const repository = {
    listDueLowStockAlertRetries: async () => { throw new Error("db down"); }
  } as unknown as ProductRepository;
  await assert.doesNotReject(() => runLowStockAlertRetryPass(repository));
});
