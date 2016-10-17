import { ISettings, merlin, types } from "../shared";
import * as command from "./command";
import * as processes from "./processes";
import * as _ from "lodash";
import * as path from "path";
import Loki = require("lokijs");
import * as rpc from "vscode-jsonrpc";
import * as server from "vscode-languageserver";

/**
 * Index for outline metadata
 */
export class Index {
  public populated: boolean = false;
  private readonly db: Loki = new Loki(".vscode.reasonml.loki");
  private readonly symbols: LokiCollection<types.SymbolInformation>;
  private session: Session;

  constructor(session: Session) {
    this.session = session;
    this.symbols = this.db.addCollection<types.SymbolInformation>("symbols", {
      indices: [ "name" ],
    });
    return this;
  }

  public findSymbols(query: LokiQuery): types.SymbolInformation[] {
    let result: types.SymbolInformation[] = [];
    try {
      result = this.symbols.chain().find(query).simplesort("name").data();
    } catch (err) {
      //
    }
    return result;
  }

  public async indexSymbols({ uri }: types.TextDocumentIdentifier): Promise<void | server.ResponseError<void>> {
    const request = merlin.Query.outline();
    const response = await this.session.merlin.query(request, uri);
    if (response.class !== "return") return new rpc.ResponseError(-1, "indexSymbols: failed", undefined);
    for (const item of merlin.Outline.intoCode(response.value, uri)) {
      const prefix = item.containerName ? `${item.containerName}.` : "";
      item.name = `${prefix}${item.name}`;
      item.containerName = path.relative(this.session.initConf.rootPath, uri.substr(5));
      this.symbols.insert(item);
    }
  };

  public async initialize(): Promise<void> {
    return;
  }

  public async populate(origin: types.TextDocumentIdentifier): Promise<void> {
    if (!this.populated) {
      this.populated = true;
      const modules = await command.getModules(this.session, origin);
      for (const id of modules) {
        if (/\.(ml|re)i$/.test(id.uri)) continue;
        const document = await command.getTextDocument(this.session, id);
        await this.session.merlin.sync(merlin.Sync.tell("start", "end", document.getText()), id.uri);
        await this.refreshSymbols(id);
      }
    }
  }

  public refreshSymbols(id: types.TextDocumentIdentifier): Promise<void | server.ResponseError<void>> {
    this.removeSymbols(id);
    return this.indexSymbols(id);
  }

  public removeSymbols({ uri }: types.TextDocumentIdentifier): void {
    this.symbols
      .chain()
      .where((item) => item.location.uri === uri)
      .remove();
  }
}

/**
 * Diagnostics manager for the session.
 */
export class Diagnostics {
  public refreshImmediate: ((event: types.TextDocumentIdentifier) => Promise<void>);
  public refreshDebounced: ((event: types.TextDocumentIdentifier) => Promise<void>) & _.Cancelable;
  private session: Session;

  constructor(session: Session) {
    this.session = session;
    return this;
  }

  public clear(event: types.TextDocumentIdentifier): void {
    this.session.connection.sendDiagnostics({
      diagnostics: [],
      uri: event.uri,
    });
  }

  public async initialize(): Promise<void> {
    this.onDidChangeConfiguration();
  }

  public onDidChangeConfiguration(): void {
    this.refreshImmediate = this.refreshWithKind(server.TextDocumentSyncKind.Full);
    this.refreshDebounced = _.debounce(
      this.refreshWithKind(server.TextDocumentSyncKind.Incremental),
      this.session.settings.reason.debounce.linter,
      { trailing: true },
    );
  }

  public refreshWithKind(syncKind: server.TextDocumentSyncKind): (event: types.TextDocumentIdentifier) => Promise<void> {
    return async (id) => {
      const document = await command.getTextDocument(this.session, id);
      if (syncKind === server.TextDocumentSyncKind.Full) {
        await this.session.merlin.sync(merlin.Sync.tell("start", "end", document.getText()), id.uri);
      }
      const errors = await this.session.merlin.query(merlin.Query.errors(), id.uri);
      if (errors.class !== "return") return;
      const diagnostics = errors.value.map(merlin.ErrorReport.intoCode);
      this.session.connection.sendDiagnostics({ diagnostics, uri: id.uri });
    };
  }

  // public async refreshWorkspace(event: types.TextDocumentIdentifier): Promise<void> {
  //   const workspaceMods = await command.getModules(this.session, event);
  //   for (const uri of workspaceMods) this.refreshImmediate(uri);
  // }
}

/**
 * Document synchronizer for the session.
 */
export class Synchronizer {
  private session: Session;

  constructor(session: Session) {
    this.session = session;
    return this;
  }

  public async initialize(): Promise<void> {
    return;
  }

  public listen(): void {
    this.session.connection.onDidCloseTextDocument((event) => {
      this.session.diagnostics.clear(event.textDocument);
    });

    this.session.connection.onDidOpenTextDocument(async (event): Promise<void> => {
      const request = merlin.Sync.tell("start", "end", event.textDocument.text);
      await this.session.merlin.sync(request, event.textDocument.uri);
      this.session.diagnostics.refreshImmediate(event.textDocument);
      // this.session.index.refreshSymbols(event.textDocument);
      await this.session.index.populate(event.textDocument);
      // this.session.diagnostics.refreshWorkspace(event.textDocument);
    });

    this.session.connection.onDidChangeTextDocument(async (event): Promise<void> => {
      for (const change of event.contentChanges) {
        if (change && change.range) {
          const startPos = merlin.Position.fromCode(change.range.start);
          const endPos = merlin.Position.fromCode(change.range.end);
          const request = merlin.Sync.tell(startPos, endPos, change.text);
          await this.session.merlin.sync(request, event.textDocument.uri);
        }
      }
      this.session.diagnostics.refreshDebounced(event.textDocument);
    });

    this.session.connection.onDidSaveTextDocument(async (event): Promise<void> => {
      this.session.diagnostics.refreshImmediate(event.textDocument);
      // this.session.diagnostics.refreshWorkspace(event.textDocument);
    });
  }

  public onDidChangeConfiguration(): void {
    return;
  }
}

/**
 * Manager for the session. Launched on client connection.
 */
export class Session {
  public initConf: server.InitializeParams;
  public settings: ISettings = ({} as any);
  public readonly connection: server.IConnection = server.createConnection(
    new server.IPCMessageReader(process),
    new server.IPCMessageWriter(process),
  );
  public readonly diagnostics: Diagnostics;
  public readonly index: Index;
  public readonly merlin: processes.Merlin;
  public readonly synchronizer: Synchronizer;

  constructor() {
    this.diagnostics = new Diagnostics(this);
    this.index = new Index(this);
    this.merlin = new processes.Merlin(this);
    this.synchronizer = new Synchronizer(this);
    return this;
  }

  public async initialize(): Promise<void> {
    await this.merlin.initialize();
    await this.index.initialize();
    await this.synchronizer.initialize();
    await this.diagnostics.initialize();
  }

  public listen(): void {
    this.synchronizer.listen();
    this.connection.listen();
  }

  log(data: any): void {
    this.connection.console.log(JSON.stringify(data, null as any, 2)); // tslint:disable-line
  }

  public onDidChangeConfiguration({ settings }: server.DidChangeConfigurationParams): void {
    this.settings = settings;
    this.diagnostics.onDidChangeConfiguration();
    this.synchronizer.onDidChangeConfiguration();
  }
}
