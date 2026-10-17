/**
 * CLI 結束碼（規格第 5 節）。錯誤訊息要寫出原因與限制值，讓 Claude 能自行修正。
 */
export const ExitCode = {
  OK: 0,
  INTERNAL: 1,
  INVALID_ARGS: 2,
  RISK_REJECTED: 3,
  BROKER_ERROR: 4,
  OUT_OF_SESSION: 5,
  PAUSED: 6,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export class CtradeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: ExitCode,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CtradeError';
  }
}

export const invalidArgs = (code: string, message: string, details?: Record<string, unknown>) =>
  new CtradeError(code, message, ExitCode.INVALID_ARGS, details);

export const riskRejected = (code: string, message: string, details?: Record<string, unknown>) =>
  new CtradeError(code, message, ExitCode.RISK_REJECTED, details);

export const internalError = (code: string, message: string, details?: Record<string, unknown>) =>
  new CtradeError(code, message, ExitCode.INTERNAL, details);
