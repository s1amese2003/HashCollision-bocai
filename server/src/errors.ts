/** Error with an HTTP status and a stable machine-readable code. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, msg: string) => new AppError(400, code, msg);
export const unauthorized = (msg = '请先登录') => new AppError(401, 'UNAUTHORIZED', msg);
export const forbidden = (msg = '没有权限') => new AppError(403, 'FORBIDDEN', msg);
export const notFound = (msg = '不存在') => new AppError(404, 'NOT_FOUND', msg);
export const conflict = (code: string, msg: string) => new AppError(409, code, msg);
