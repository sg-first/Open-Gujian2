# -*- coding: utf-8 -*-
"""山河行 本地服务器 —— 修正 Windows 下 .js MIME 误判问题"""
import http.server
import socketserver
import os
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8461
ROOT = os.path.dirname(os.path.abspath(__file__))

MIMES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.dds': 'image/vnd-ms.dds',
    '.bin': 'application/octet-stream',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
}


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = MIMES

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        return MIMES.get(ext, 'application/octet-stream')

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == '__main__':
    os.chdir(ROOT)
    with Server(('127.0.0.1', PORT), Handler) as httpd:
        print(f'山河行服务器已启动: http://127.0.0.1:{PORT}')
        print('关闭此窗口即可停止')
        httpd.serve_forever()
