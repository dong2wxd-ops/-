// @ts-check
import { module } from "@prisma/composer";
import tongciXiangyuService from "./service.mjs";

export default module("incredible-plum-wombat", ({ provision }) => {
  provision(tongciXiangyuService, { id: "tongcixiangyu" });
});
