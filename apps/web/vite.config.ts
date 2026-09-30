import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { callDaemon, createBridge, endpoint } from "./server/bridge";

export default defineConfig(({ mode }) => {
  const root = fileURLToPath(new URL(".", import.meta.url));
  const env = loadEnv(mode, root, "HARNESS_DAEMON_INSTANCE");
  const instance =
    process.env.HARNESS_DAEMON_INSTANCE ?? env.HARNESS_DAEMON_INSTANCE;
  const bridge = () =>
    createBridge((request) => callDaemon(request, endpoint(instance)));
  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: "harness-local-bridge",
        configureServer(server) {
          server.middlewares.use(bridge());
        },
        configurePreviewServer(server) {
          server.middlewares.use(bridge());
        },
      },
    ],
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            primitives: ["radix-ui"],
            markdown: ["react-markdown", "remark-gfm"],
            protocol: ["@harness/protocol"],
          },
        },
      },
    },
    server: { host: "127.0.0.1", port: 5180, strictPort: true },
  };
});
