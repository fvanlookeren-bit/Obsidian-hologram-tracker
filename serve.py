#!/usr/bin/env python3
# Servidor local que MANDA no-cache → cada reload trae los últimos cambios
# sin tener que hacer Cmd+Shift+R. Sirve desde el directorio actual.
import http.server
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8123


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, *args):  # silencio
        pass


socketserver.ThreadingTCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(('', PORT), NoCacheHandler) as httpd:
    print(f'Sirviendo (sin caché) en http://localhost:{PORT}  ·  Ctrl+C para detener')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
