import { describe, expect, it } from "vitest";
import {
  generatePayloadProto,
  tableNameToProtoFilename,
} from "../src/codegen/proto-gen.js";

describe("generatePayloadProto", () => {
  it("generates a valid .proto for a click_events table", () => {
    const proto = generatePayloadProto({
      table: "ingest.click_events",
      columns: [
        { name: "user_id", type: "string" },
        { name: "url", type: "string" },
        { name: "is_bot", type: "boolean", description: "Whether the user is a bot" },
        { name: "click_count", type: "int32" },
      ],
    });

    expect(proto).toContain('syntax = "proto3";');
    expect(proto).toContain("package lattik.logger.v1;");
    expect(proto).toContain("message IngestClickEvents {");
    expect(proto).toContain("optional string user_id = 1;");
    expect(proto).toContain("optional string url = 2;");
    expect(proto).toContain("// Whether the user is a bot");
    expect(proto).toContain("optional bool is_bot = 3;");
    expect(proto).toContain("optional int32 click_count = 4;");
  });

  it("maps all column types correctly", () => {
    const proto = generatePayloadProto({
      table: "test.all_types",
      columns: [
        { name: "s", type: "string" },
        { name: "i32", type: "int32" },
        { name: "i64", type: "int64" },
        { name: "f", type: "float" },
        { name: "d", type: "double" },
        { name: "b", type: "boolean" },
        { name: "ts", type: "timestamp" },
        { name: "dt", type: "date" },
        { name: "j", type: "json" },
      ],
    });

    expect(proto).toContain("message TestAllTypes {");
    expect(proto).toContain("optional string s = 1;");
    expect(proto).toContain("optional int32 i32 = 2;");
    expect(proto).toContain("optional int64 i64 = 3;");
    expect(proto).toContain("optional float f = 4;");
    expect(proto).toContain("optional double d = 5;");
    expect(proto).toContain("optional bool b = 6;");
    expect(proto).toContain("optional string ts = 7;");
    expect(proto).toContain("optional string dt = 8;");
    expect(proto).toContain("optional bytes j = 9;");
  });
});

describe("tableNameToProtoFilename", () => {
  it("converts dot-separated table name to underscore filename", () => {
    expect(tableNameToProtoFilename("ingest.click_events")).toBe(
      "ingest_click_events.proto",
    );
  });
});
