import { Module } from "@nestjs/common";
import { DemoController } from "./demo.controller.js";

@Module({ controllers: [DemoController] })
export class DemoModule {}
