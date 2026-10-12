import { Controller, Get, Header } from "@nestjs/common";
import { readFile } from "node:fs/promises";
import { authConfiguration } from "../infrastructure/auth/auth-configuration.js";

@Controller("demo")
export class DemoController {
  // Only presentation assets and public OIDC settings are anonymous. Financial routes retain their guards.
  @Get()
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Cache-Control", "no-store")
  @Header("X-Content-Type-Options", "nosniff")
  page(): Promise<string> { return readFile(new URL("./index.html", import.meta.url), "utf8"); }

  @Get("app.js")
  @Header("Content-Type", "text/javascript; charset=utf-8")
  @Header("Cache-Control", "no-store")
  script(): Promise<string> { return readFile(new URL("./app.js", import.meta.url), "utf8"); }

  @Get("styles.css")
  @Header("Content-Type", "text/css; charset=utf-8")
  @Header("Cache-Control", "no-store")
  styles(): Promise<string> { return readFile(new URL("./styles.css", import.meta.url), "utf8"); }

  @Get("config")
  @Header("Cache-Control", "no-store")
  configuration() { return { issuer: authConfiguration().issuer, clientId: "demo-ui" }; }
}
