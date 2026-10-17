import { createInterface } from 'node:readline';
import { CtradeError, ExitCode } from '../core/errors.js';

/**
 * 互動式輸入密碼：不回顯、提示寫到 stderr（stdout 保留給 JSON 輸出）。
 * 只在終端機執行時可用，避免密碼經由管線或參數傳入。
 */
export function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return Promise.reject(new CtradeError('NOT_A_TTY', '需要在終端機中互動式輸入密碼', ExitCode.INVALID_ARGS));
  }
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    let prompted = false;
    // 只輸出提示文字本身，使用者輸入的字元不回顯
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (!prompted) {
        process.stderr.write(s);
        prompted = true;
      }
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });
  });
}
