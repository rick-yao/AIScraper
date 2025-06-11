/**
 * 代表一次 AI 请求的 token 使用情况。
 */
export interface RequestUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * 一个用于收集和报告 AI API 使用情况统计的类。
 */
export class StatsCollector {
  private requestCount = 0;
  private totalPromptTokens = 0;
  private totalCompletionTokens = 0;
  private totalTokens = 0;

  /**
   * 将单次 AI 请求的 token 使用量添加到总数中。
   * @param usage - 从 AI SDK 响应中获取的 usage 对象。
   */
  public addRequest(usage: RequestUsage): void {
    this.requestCount++;
    this.totalPromptTokens += usage.promptTokens;
    this.totalCompletionTokens += usage.completionTokens;
    this.totalTokens += usage.totalTokens;
  }

  /**
   * 在控制台打印一份格式化好的统计报告。
   */
  public printReport(): void {
    console.log('\n--- AI 使用情况统计 ---');
    console.log(`总请求次数: ${this.requestCount}`);
    // 使用 toLocaleString() 让大数字更易读
    console.log(`总消耗Token: ${this.totalTokens.toLocaleString()}`);
    console.log(`  - 提问 (Prompt) Token: ${this.totalPromptTokens.toLocaleString()}`);
    console.log(`  - 回答 (Completion) Token: ${this.totalCompletionTokens.toLocaleString()}`);
    console.log('------------------------');
  }
}
