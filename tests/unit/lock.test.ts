import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test";
import { createRunLock } from "../../src/lib/utils";

describe("createRunLock promise serialization & dead-letter handling", () => {
  let errSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
  });
  it("executes tasks sequentially in FIFO order", async () => {
    const lock = createRunLock("test-fifo");
    const order: number[] = [];

    const p1 = lock(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
      return "one";
    });

    const p2 = lock(async () => {
      order.push(2);
      return "two";
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("one");
    expect(r2).toBe("two");
    expect(order).toEqual([1, 2]);
  });

  it("dead-letter isolation: failure in one task does not break the chain or swallow error", async () => {
    const lock = createRunLock("test-dead-letter");

    const p1 = lock(async () => {
      throw new Error("task 1 exploded");
    });

    const p2 = lock(async () => {
      return "task 2 ok";
    });

    // p1 must reject with its own error for caller to catch
    await expect(p1).rejects.toThrow("task 1 exploded");

    // p2 must still succeed and not be poisoned or broken
    const r2 = await p2;
    expect(r2).toBe("task 2 ok");
    expect(lock.getDeadLetterCount()).toBe(1);
  });

  it("handles multiple consecutive rejections without breaking later tasks", async () => {
    const lock = createRunLock("test-consecutive-fails");

    const p1 = lock(async () => {
      throw new Error("fail 1");
    });
    const p2 = lock(async () => {
      throw new Error("fail 2");
    });
    const p3 = lock(async () => {
      return "recovered";
    });

    await expect(p1).rejects.toThrow("fail 1");
    await expect(p2).rejects.toThrow("fail 2");
    const r3 = await p3;
    expect(r3).toBe("recovered");
    expect(lock.getDeadLetterCount()).toBe(2);
  });

  it("reset clears dead letter count", () => {
    const lock = createRunLock("test-reset");
    lock.reset();
    expect(lock.getDeadLetterCount()).toBe(0);
  });
});
