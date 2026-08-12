import express from "express";
import { createServer, Server } from "http";
import nepheleServer from "nephele";
import FileSystemAdapter from "@nephele/adapter-file-system";
import CustomAuthenticator, { User } from "@nephele/authenticator-custom";
import { randomBytes } from "crypto";
import { getRandomFreePort } from "./asset-paths";

export interface ShareConfig {
  port: number;
  token: string;
}

export class HttpShare {
  private server: Server | null = null;
  public readonly token: string;
  public port = 0;

  constructor() {
    this.token = randomBytes(16).toString("hex");
  }

  async start(workspaceDir: string): Promise<ShareConfig> {
    this.port = await getRandomFreePort();

    const app = express();
    // Log every WebDAV request method, path, and response status
    app.use((req, res, next) => {
      res.on("finish", () => {
        console.log(`[share] ${req.method} ${req.originalUrl} -> ${res.statusCode}`);
      });
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
      this.server.listen(this.port, "127.0.0.1", () => {
        resolve({ port: this.port, token: this.token });
      });
      this.server.on("error", reject);
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => this.server!.close(() => resolve()));
    }
  }
}


