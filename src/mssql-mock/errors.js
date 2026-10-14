// Error classes shaped like the ones node-mssql throws, so catch blocks written
// against the mock (err.number, err.code === 'EREQUEST') keep working against
// the real driver.

export class MSSQLError extends Error {
  constructor(message, code) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}

export class ConnectionError extends MSSQLError {
  constructor(message, code = 'ECONNCLOSED') {
    super(message, code);
  }
}

export class RequestError extends MSSQLError {
  constructor(message, { number, state = 1, severity = 16, procName, lineNumber = 1 } = {}) {
    super(message, 'EREQUEST');
    this.number = number;
    this.state = state;
    this.class = severity;
    this.lineNumber = lineNumber;
    this.procName = procName;
    this.serverName = 'mock';
  }
}
