export type AppErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "PERMISSION_DENIED"
  | "CONFLICT"
  | "PERSISTENCE_ERROR";

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: AppErrorCode,
    message: string,
    status: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("VALIDATION_ERROR", message, 400, details);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found") {
    super("NOT_FOUND", message, 404);
  }
}

export class PermissionError extends AppError {
  constructor(message = "Access denied") {
    super("PERMISSION_DENIED", message, 403);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("CONFLICT", message, 409, details);
  }
}

export class PersistenceError extends AppError {
  constructor(message = "A persistence error occurred", details?: Record<string, unknown>) {
    super("PERSISTENCE_ERROR", message, 500, details);
  }
}
