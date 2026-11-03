import http from 'node:http';

const HTML = `<!doctype html>
<html>
<head><meta charset="utf-8" /><title>Test dApp</title></head>
<body><p>Test dApp page for Inscrib3 E2E tests.</p></body>
</html>`;

export function startDappServer(port: number): Promise<() => Promise<void>> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(HTML);
    });
    server.listen(port, () => {
      resolve(
        () =>
          new Promise((closed) => {
            // Browsers keep the HTTP/1.1 connection open (keep-alive) even
            // after the page finished loading - server.close() alone waits
            // for it to be released and hangs past the test timeout.
            server.closeAllConnections();
            server.close(() => closed());
          }),
      );
    });
  });
}
