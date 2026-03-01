class AppError extends Error {
  constructor(code, message, statusCode = 500) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function errorHandler(err, req, res, next) {
  const statusCode = err.statusCode || 500;
  const code = err.code || 'INTERNAL_ERROR';
  const message = err.message || 'An unexpected error occurred';

  if (statusCode >= 500) {
    console.error(`[${req.method} ${req.path}] ${code}: ${message}`, err.stack);
  }

  res.status(statusCode).json({
    ok: false,
    error: { code, message },
  });
}

module.exports = { AppError, errorHandler };
