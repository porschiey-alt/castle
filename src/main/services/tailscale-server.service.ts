/**
 * Tailscale Server Service - HTTP static file server for remote access
 *
 * Serves the built Angular SPA over HTTP so that devices on the same
 * Tailscale tailnet (or local network) can access Castle via a browser.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { createLogger } from './logger.service';

const log = createLogger('TailscaleServer');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

export class TailscaleServerService extends EventEmitter {
  private server: http.Server | null = null;
  private port: number;
  private staticDir: string;
  private devServerUrl: string | null;

  constructor(port: number = 39417) {
    super();
    this.port = port;
    // Resolve the built Angular output directory (dist/main/services → dist/renderer/browser)
    this.staticDir = path.join(__dirname, '../../renderer/browser');
    // When the Angular dev server is running, proxy to it instead of serving static files
    this.devServerUrl = process.env['ELECTRON_DEV_SERVER'] === 'true' ? 'http://localhost:4200' : null;
    log.info(`Static dir: ${this.staticDir}`);
    log.info(`Index exists: ${fs.existsSync(path.join(this.staticDir, 'index.html'))}`);
    if (this.devServerUrl) {
      log.info(`Dev mode: proxying to ${this.devServerUrl}`);
    }
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on('error', (err) => {
        log.error('Server error', err);
        reject(err);
      });

      this.server.listen(this.port, '0.0.0.0', () => {
        log.info(`Listening on http://0.0.0.0:${this.port}`);
        resolve();
      });
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  getPort(): number {
    return this.port;
  }

  isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  /** Return the underlying http.Server for WebSocket upgrades */
  getHttpServer(): http.Server | null {
    return this.server;
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // In dev mode, proxy to the Angular dev server
    if (this.devServerUrl) {
      this.proxyRequest(req, res);
      return;
    }

    const url = new URL(req.url || '/', `http://localhost:${this.port}`);
    let filePath = path.join(this.staticDir, url.pathname);

    // Security: prevent directory traversal
    if (!filePath.startsWith(this.staticDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    // If the path is a directory, look for index.html
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }

    // Try to serve the file, fall back to index.html for SPA routing
    if (fs.existsSync(filePath)) {
      this.serveFile(filePath, res);
    } else {
      // SPA fallback — serve index.html
      const indexPath = path.join(this.staticDir, 'index.html');
      if (fs.existsSync(indexPath)) {
        this.serveFile(indexPath, res);
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    }
  }

  private serveFile(filePath: string, res: http.ServerResponse): void {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    const stream = fs.createReadStream(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    stream.pipe(res);
    stream.on('error', () => {
      res.writeHead(500);
      res.end('Internal Server Error');
    });
  }

  /** Proxy a request to the Angular dev server */
  private proxyRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const proxyUrl = `${this.devServerUrl}${req.url || '/'}`;
    const proxyReq = http.request(proxyUrl, { method: req.method, headers: req.headers }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', () => {
      res.writeHead(502);
      res.end('Dev server unavailable');
    });
    req.pipe(proxyReq);
  }
}
