import { schema, type SchemaType } from "@/schema";
import { useAutoFillBuckets } from "@webextkits/storage-local";
import { registerMessages } from "./messages";

useAutoFillBuckets<SchemaType>(schema);
registerMessages();
