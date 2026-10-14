# submission-flow-demo
Single-repo demo of an accept-fast submission flow in Node ESM. A server-rendered Express + Eta front end posts a form with an idempotency key to an Express API, which writes one JSON row via stored procedure, returns 202, then processes and pushes status over SSE. Includes an in-memory node-mssql mock, so it runs end to end without SQL Server.
