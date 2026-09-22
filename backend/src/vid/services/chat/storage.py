import httpx
from abc import ABC, abstractmethod
from urllib.parse import quote

from vid.config import settings


class ChatStorage(ABC):
    @abstractmethod
    async def upload(self, path: str, data: bytes, content_type: str) -> None: ...

    @abstractmethod
    async def signed_download_url(self, path: str, expires_in: int) -> str: ...


class SupabaseChatStorage(ChatStorage):
    def __init__(self) -> None:
        if not settings.SUPABASE_URL or not settings.SUPABASE_SERVICE_ROLE_KEY:
            raise RuntimeError(
                "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for chat attachments"
            )
        self.base = settings.SUPABASE_URL.rstrip("/")
        self.key = settings.SUPABASE_SERVICE_ROLE_KEY
        self.bucket = settings.CHAT_STORAGE_BUCKET

    def _headers(self, content_type: str | None = None) -> dict[str, str]:
        headers = {"Authorization": f"Bearer {self.key}", "apikey": self.key}
        if content_type:
            headers["Content-Type"] = content_type
        return headers

    async def upload(self, path: str, data: bytes, content_type: str) -> None:
        url = (
            f"{self.base}/storage/v1/object/"
            f"{quote(self.bucket, safe='')}/{quote(path, safe='/')}"
        )
        async with httpx.AsyncClient(timeout=120) as client:
            response = await client.post(
                url, content=data, headers=self._headers(content_type)
            )
            response.raise_for_status()

    async def signed_download_url(self, path: str, expires_in: int) -> str:
        url = (
            f"{self.base}/storage/v1/object/sign/"
            f"{quote(self.bucket, safe='')}/{quote(path, safe='/')}"
        )
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                url,
                json={"expiresIn": expires_in},
                headers=self._headers("application/json"),
            )
            response.raise_for_status()
            data = response.json()
        signed = data.get("signedURL") or data.get("signedUrl")
        if not signed:
            raise RuntimeError("Supabase Storage did not return a signed URL")
        return signed if signed.startswith("http") else f"{self.base}{signed}"


def get_chat_storage() -> ChatStorage:
    return SupabaseChatStorage()
