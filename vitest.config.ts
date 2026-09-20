import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    /**
     * 求解器测试的超时。
     *
     * night-02（9 回合 / 7 患者）单次穷尽求解实测约 28s —— 已经贴着旧的 30s 上限，
     * 而单线程跑全量时前面几个重关留下的堆会让 GC 更频繁，同一条测试偶发超 30s
     * （假失败：单跑必过、全量偶挂）。这里给到 120s 留出 4× 余量。
     */
    testTimeout: 120_000,
    /**
     * 内存护栏：用**单进程线程池**而不是多进程 fork。
     *
     * 求解器在「无解」时要穷尽整个状态空间才肯返回，堆会涨到数 GB；
     * 多进程池会把每个 worker 的堆叠加，曾把系统 swap 吃到 20G+ 导致机器卡死。
     * 线程池共享一个堆，配合各测试里的 15 万节点上限共同封顶。
     */
    pool: "threads",
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
  },
});
