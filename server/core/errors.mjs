/**
 * 存储层统一业务错误。
 * code 供 API 层映射 HTTP 状态（如 INVALID→400、CONFLICT→409），
 * current 仅在乐观并发冲突时携带库中最新记录，供前端做覆盖确认。
 */
export class StoreError extends Error {
  constructor(code, message, current) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.current = current;
  }
}
