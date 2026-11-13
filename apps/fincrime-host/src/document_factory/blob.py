"""Training folders in Azure Blob Storage for the Document Intelligence resource to read (plan §7.3, dataset storage).

Azure deployments use a plain container URL and managed identities. Local callers may supply a
container SAS URL through FACTORY_TRAINING_CONTAINER_URL. The URL is never logged. Hosts outside
*.blob.core.windows.net are refused.
"""
from __future__ import annotations

import re
import urllib.parse
from dataclasses import dataclass
from typing import Callable

from .azure_di import Transport

HOST = re.compile(r"^[a-z0-9]{3,24}\.blob\.core\.windows\.net$")
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,900}$")


class BlobError(RuntimeError):
    pass


@dataclass
class TrainingContainer:
    container_url: str  # https://<account>.blob.core.windows.net/<container>?<sas>
    transport: Transport
    token: Callable[[], str] | None = None

    def __post_init__(self):
        parts = urllib.parse.urlsplit(self.container_url)
        if parts.scheme != "https" or not HOST.match(parts.hostname or "") or parts.path.count("/") != 1 or parts.port or parts.username:
            raise BlobError("training container URL must be https://<account>.blob.core.windows.net/<container>?<sas>")
        if self.token and (parts.query or parts.fragment):
            raise BlobError("managed identity requires a training container URL without query parameters")
        self._base, self._query = f"https://{parts.hostname}{parts.path}", parts.query

    def url(self) -> str:
        """The container URL Document Intelligence trains from (with its SAS)."""
        return self.container_url

    def put(self, name: str, data: bytes, content_type: str) -> None:
        if not NAME.match(name) or ".." in name:
            raise BlobError(f"blob name refused: {name[:80]}")
        target = f"{self._base}/{urllib.parse.quote(name)}" + (f"?{self._query}" if self._query else "")
        headers = {"x-ms-blob-type": "BlockBlob", "Content-Type": content_type, "x-ms-version": "2023-11-03"}
        if self.token:
            from email.utils import formatdate

            headers.update({"Authorization": f"Bearer {self.token()}", "x-ms-date": formatdate(usegmt=True)})
        status, _, _ = self.transport("PUT", target, headers, data)
        if status not in (200, 201):
            raise BlobError(f"upload of {name} failed with HTTP {status}")
