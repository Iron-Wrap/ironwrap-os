import { createServer } from "node:http";

const port = Number(process.env.ERPNEXT_STUB_PORT || "19090");
const actor = process.env.ERPNEXT_STUB_USER || "owner@example.com";

const server = createServer((request, response) => {
  if (request.url === "/api/method/frappe.auth.get_logged_user") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: actor }));
    return;
  }

  if (request.url?.startsWith("/api/resource")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [] }));
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end("{}");
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const boundPort =
    typeof address === "object" && address ? address.port : port;
  console.log(`stub ERPNext server on http://127.0.0.1:${boundPort}`);
});
