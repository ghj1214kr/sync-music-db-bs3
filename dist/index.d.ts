/// <reference types="node" />
import chokidar from "chokidar";
import { EventEmitter } from "events";
import { Database, Statement } from "better-sqlite3";
declare type metadata = {
    [key: string]: number | string;
};
interface SyncMusicDbType {
    db: Database;
    dirs: string[];
    delay?: number;
}
declare class SyncMusicDb extends EventEmitter {
    db: Database;
    dirs: string[];
    delay: number;
    localMtimes: Map<string, number>;
    isReady: boolean;
    isSynced: boolean;
    removeDirStmt?: Statement;
    removeTrackStmt?: Statement;
    upsertTrackStmt?: Statement;
    watcher?: chokidar.FSWatcher;
    static TRACK_ATTRS: string[];
    constructor({ db, dirs, delay }: SyncMusicDbType);
    static getMetaData(filePath: string): Promise<metadata | {}>;
    createTable(): void;
    prepareStatements(): void;
    finalizeStatements(): void;
    removeDbDir(dir: string): void;
    removeDbTrack(trackPath: string): void;
    upsertDbTrack(track: metadata, update?: boolean): void;
    refreshLocalMtimes(): Promise<void>;
    removeDeadTracks(): void;
    addUpdatedTracks(): Promise<void>;
    refreshWatcher(): void;
    refresh(): this;
    close(): Promise<void>;
    addDirs(dirs: string[]): void;
    removeDirs(dirs: string[]): void;
}
export default SyncMusicDb;
