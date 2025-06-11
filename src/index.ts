import { Command } from 'commander';
import path from 'path';
import fs from 'fs/promises';
import { organizeMediaLibrary } from './organizer.js';

const program = new Command();

program
  .version('2.1.0') // 版本升级，支持并行处理
  .description('使用AI并行整理媒体文件，合并系列，并为Jellyfin创建标准化的软链接')
  .requiredOption('-s, --source <path>', '源文件夹路径')
  .requiredOption('-t, --target <path>', '用于存放软链接的目标文件夹路径')
  // 新增 --concurrency 选项
  .option('-c, --concurrency <number>', '并行处理的并发请求数', '10')
  .option('--debug', '启用调试模式，不会创建软链接，而是生成一个包含整理计划的JSON文件');

program.parse(process.argv);

const options = program.opts();

const sourcePath = path.resolve(options.source);
const targetPath = path.resolve(options.target);
const isDebugMode = !!options.debug;
// 解析并发数选项
const concurrency = parseInt(options.concurrency, 10);

/**
 * 主函数
 */
async function main() {
  console.log(`源路径: ${sourcePath}`);
  console.log(`目标路径: ${targetPath}`);
  console.log(`并行数: ${concurrency}`);


  if (isDebugMode) {
    console.log('*** 调试模式已启用 ***');
    console.log('将不会创建任何文件或目录，仅生成调试日志。');
  }

  // 验证路径
  try {
    const stats = await fs.stat(sourcePath);
    if (!stats.isDirectory()) {
      console.error(`错误: 源路径不是一个目录: ${sourcePath}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`错误: 源路径不存在或无法访问: ${sourcePath}`);
    process.exit(1);
  }

  try {
    await fs.mkdir(targetPath, { recursive: true });
  } catch (error) {
    console.error(`错误: 无法创建或访问目标目录: ${targetPath}`);
    process.exit(1);
  }

  // 调用核心整理函数，并传入并发数
  await organizeMediaLibrary(sourcePath, targetPath, isDebugMode, concurrency);

  console.log('\n处理完成。');
}

main().catch(error => {
  console.error('\n发生意外错误:', error);
  process.exit(1);
});
