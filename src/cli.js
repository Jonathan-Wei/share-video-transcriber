#!/usr/bin/env node

import process from 'node:process';
import { downloadSharedVideo } from './downloader.js';
import { extractFirstUrl, parseArgs, printHelp } from './utils.js';

main().catch((error) => {
  console.error(`下载失败: ${error.message}`);
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  if (!options.input) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  const shareUrl = extractFirstUrl(options.input);
  if (!shareUrl) {
    throw new Error('没有在输入参数中找到有效的 http(s) 链接');
  }

  options.sourceText = options.input;
  const result = await downloadSharedVideo(shareUrl, options);
  if (options.json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(`已保存: ${result.outputPath}`);
    console.log(`元数据: ${result.metadataPath}`);
    console.log(`视频地址: ${result.videoUrl}`);
  }
}
