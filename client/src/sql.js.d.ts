// Minimal type declarations for sql.js 1.14.x (package ships no .d.ts).
declare module 'sql.js' {
  export type SqlValue = string | number | Uint8Array<ArrayBuffer> | null;
  export type BindParams = SqlValue[] | Record<string, SqlValue>;

  export interface QueryExecResult {
    columns: string[];
    values: SqlValue[][];
  }

  export interface Statement {
    bind(values?: BindParams): boolean;
    step(): boolean;
    get(): SqlValue[];
    getAsObject(): Record<string, SqlValue>;
    free(): boolean;
  }

  export interface Database {
    exec(sql: string, params?: BindParams): QueryExecResult[];
    run(sql: string, params?: BindParams): Database;
    prepare(sql: string, params?: BindParams): Statement;
    export(): Uint8Array;
    close(): void;
    getRowsModified(): number;
  }

  export interface SqlJsConfig {
    locateFile?: (file: string) => string;
  }

  export interface SqlJsStatic {
    Database: new (data?: Uint8Array) => Database;
  }

  export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
}
