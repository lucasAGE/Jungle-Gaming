import { MikroORM } from "@mikro-orm/core";
import { Inject, Injectable, Module, type OnApplicationShutdown } from "@nestjs/common";
import { createOrm } from "./orm.js";

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: Awaited<ReturnType<typeof createOrm>>) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}

@Module({
  providers: [
    { provide: MikroORM, useFactory: () => createOrm() },
    DatabaseLifecycle,
  ],
  exports: [MikroORM],
})
export class DatabaseModule {}
