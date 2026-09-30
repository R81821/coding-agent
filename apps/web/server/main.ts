import { preview } from "vite";
// Vite's preview server uses the same restricted local bridge as development.
const server = await preview({
  preview: { host: "127.0.0.1", port: 5180, strictPort: true },
});
server.printUrls();
