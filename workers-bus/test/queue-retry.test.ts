import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.ts";

const transports = [
  { primary: "jn-push", dlq: "jn-dlq", body: { envelope_id: "ow_synthetic" } },
  {
    primary: "measurements",
    dlq: "measurements-dlq",
    body: {
      measurement_receipt_id: "measurement_synthetic",
      lease_token: "lease_synthetic",
    },
  },
  {
    primary: "newo-events",
    dlq: "newo-dlq",
    body: { newo_event_id: "newo_synthetic" },
  },
];

async function failDelivery(queue: string, body: unknown, attempts: unknown) {
  let acked = 0;
  let reads = 0;
  const retries: unknown[][] = [];
  await worker.queue(
    {
      queue,
      messages: [
        {
          body,
          attempts,
          ack: () => {
            acked++;
          },
          retry: (...args: unknown[]) => {
            retries.push(args);
          },
        },
      ],
    } as never,
    {
      DB: {
        prepare() {
          reads++;
          throw new Error(
            "D1_ERROR: Currently processing a long-running export.",
          );
        },
      },
    } as never,
    {} as never,
  );
  assert.equal(
    reads,
    1,
    "fails on the first store read before any durable attempt increment",
  );
  assert.equal(acked, 0);
  assert.equal(retries.length, 1);
  return retries[0];
}

for (const prefix of ["ironwrap", "ironwrap-qa"]) {
  for (const transport of transports) {
    const queue = `${prefix}-${transport.primary}`;
    for (const [index, delaySeconds] of [10, 20, 40, 80, 120].entries()) {
      test(`${queue}: delivery ${index + 1} retries after ${delaySeconds}s`, async () => {
        assert.deepEqual(await failDelivery(queue, transport.body, index + 1), [
          { delaySeconds },
        ]);
      });
    }
    test(`${queue}: high attempts stay capped`, async () => {
      assert.deepEqual(await failDelivery(queue, transport.body, 10000), [
        { delaySeconds: 120 },
      ]);
    });
    test(`${prefix}-${transport.dlq}: retry has no delay argument`, async () => {
      assert.deepEqual(
        await failDelivery(`${prefix}-${transport.dlq}`, transport.body, 2),
        [],
      );
    });
  }
}

for (const attempts of [undefined, 0, -1, 1.5, NaN, Infinity, "2"]) {
  test(`invalid delivery attempts ${String(attempts)} use the first delay`, async () => {
    assert.deepEqual(
      await failDelivery("ironwrap-jn-push", transports[0].body, attempts),
      [{ delaySeconds: 10 }],
    );
  });
}
