import express from "express";
import { createServer, Server } from "http";
import nepheleServer from "nephele";
import FileSystemAdapter from "@nephele/adapter-file-system";
import CustomAuthenticator, { User } from "@nephele/authenticator-custom";
import { randomBytes } from "crypto";
import { Socket } from "net";
import { getRandomFreePort } from "./asset-paths";

export interface ShareConfig {
  port: number;
  token: string;
}

export class HttpShare {
  private server: Server | null = null;
  private sockets = new Set<Socket>();
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  public readonly token: string;
  public port = 0;

  constructor() {
    this.token = randomBytes(16).toString("hex");
  }

  async start(workspaceDir: string): Promise<ShareConfig> {
    if (this.stopping) throw new Error("Share is stopping");
    this.port = await getRandomFreePort();
    if (this.stopping) throw new Error("Share startup cancelled");

    const app = express();
    // Log every WebDAV request method, path, and response status
    app.use((req, res, next) => {
      if (process.env.VERBOSE) {
        res.on("finish", () => {
          console.log(`[share] ${req.method} ${req.originalUrl} -> ${res.statusCode}`);
        });
      }
      next();
    });
    app.use(
      "/",
      nepheleServer({
        adapter: new FileSystemAdapter({ root: workspaceDir }),
        authenticator: new CustomAuthenticator({
          getUser: async (username: string) => {
            if (username === "valence") return new User({ username });
            return null;
          },
          authBasic: async (user: User, password: string) => {
            return password === this.token;
          },
          realm: "ValenceBox Workspace",
        }),
      })
    );

    return new Promise((resolve, reject) => {
      this.server = createServer(app);
      this.server.on("connection", (socket) => {
        this.sockets.add(socket);
        socket.once("close", () => this.sockets.delete(socket));
        if (this.stopping) socket.destroy();
      });
      this.server.listen(this.port, "127.0.0.1", () => {
        resolve({ port: this.port, token: this.token });
      });
      this.server.on("error", reject);
    });
  }

  forceStop(): void {
    this.stopping = true;
    this.server?.closeAllConnections();
    for (const socket of this.sockets) socket.destroy();
  }

  stop(): Promise<void> {
    this.stopping = true;
    if (this.stopPromise) return this.stopPromise;
    const server = this.server;
    this.stopPromise = new Promise((resolve) => {
      if (!server) { resolve(); return; }
      // Stop accepting connections before terminating existing requests.
      server.close(() => {
        this.server = null;
        resolve();
      });
      this.forceStop();
    });
    return this.stopPromise;
  }
}

