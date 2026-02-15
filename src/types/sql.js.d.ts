/**
 * Type declarations for sql.js
 */

declare module 'sql.js' {
  export interface SqlJsStatic {
    Database: typeof Database;
  }

  export interface QueryExecResult {
    columns: string[];
    values: any[][];
  }

  export interface ParamsObject {
    [key: string]: any;
  }

  export interface ParamsCallback {
    (obj: ParamsObject): void;
  }

  export interface Config {
    locateFile?: (filename: string) => string;
  }

  export class Statement {
    bind(params?: any[] | ParamsObject): boolean;
    step(): boolean;
    getAsObject(params?: ParamsObject): ParamsObject;
    get(params?: any[]): any[];
    getColumnNames(): string[];
    free(): boolean;
    reset(): void;
    run(params?: any[] | ParamsObject): void;
  }

  export class Database {
    constructor(data?: ArrayLike<number> | Buffer | null);
    run(sql: string, params?: any[] | ParamsObject): Database;
    exec(sql: string, params?: any[] | ParamsObject): QueryExecResult[];
    each(sql: string, params: any[] | ParamsObject, callback: ParamsCallback, done?: () => void): Database;
    each(sql: string, callback: ParamsCallback, done?: () => void): Database;
    prepare(sql: string, params?: any[] | ParamsObject): Statement;
    export(): Uint8Array;
    close(): void;
    getRowsModified(): number;
    create_function(name: string, func: (...args: any[]) => any): Database;
    create_aggregate(name: string, functions: { init?: () => any; step: (state: any, ...args: any[]) => any; finalize: (state: any) => any }): Database;
  }

  export default function initSqlJs(config?: Config): Promise<SqlJsStatic>;
}
