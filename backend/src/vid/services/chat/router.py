from datetime import datetime
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from sqlalchemy import or_
from sqlalchemy.orm import Session

from vid.auth.dependencies import get_current_user
from vid.auth.security import verify_token
from vid.db.chat_models import ChatAttachment, ChatConversation, ChatMessage
from vid.db.models import User
from vid.db.session import get_db
from vid.services.chat.storage import ChatStorage, get_chat_storage

router = APIRouter(prefix="/api/v1/chat", tags=["Chat"])
MAX_MESSAGE_LENGTH = 10000
MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024


class StartConversationRequest(BaseModel):
    zyvano_id: str = Field(min_length=5, max_length=32)


class SendMessageRequest(BaseModel):
    body: str | None = Field(default=None, max_length=MAX_MESSAGE_LENGTH)
    attachment_id: UUID | None = None


class ConnectionManager:
    def __init__(self) -> None:
        self.connections: dict[UUID, set[WebSocket]] = {}

    async def connect(self, conversation_id: UUID, websocket: WebSocket) -> None:
        await websocket.accept()
        self.connections.setdefault(conversation_id, set()).add(websocket)

    def disconnect(self, conversation_id: UUID, websocket: WebSocket) -> None:
        sockets = self.connections.get(conversation_id)
        if not sockets:
            return
        sockets.discard(websocket)
        if not sockets:
            self.connections.pop(conversation_id, None)

    async def broadcast(self, conversation_id: UUID, payload: dict) -> None:
        dead: list[WebSocket] = []
        for websocket in self.connections.get(conversation_id, set()).copy():
            try:
                await websocket.send_json(payload)
            except Exception:
                dead.append(websocket)
        for websocket in dead:
            self.disconnect(conversation_id, websocket)


manager = ConnectionManager()


def _conversation_or_404(db: Session, user_id: UUID, conversation_id: UUID) -> ChatConversation:
    conversation = db.query(ChatConversation).filter(ChatConversation.id == conversation_id).first()
    if not conversation or not conversation.contains(user_id):
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conversation


def _message_payload(db: Session, message: ChatMessage) -> dict:
    attachment = (
        db.query(ChatAttachment).filter(ChatAttachment.id == message.attachment_id).first()
        if message.attachment_id else None
    )
    return {
        "id": str(message.id),
        "conversation_id": str(message.conversation_id),
        "sender_id": str(message.sender_id),
        "body": message.body,
        "created_at": message.created_at.isoformat(),
        "read_at": message.read_at.isoformat() if message.read_at else None,
        "attachment": None if not attachment else {
            "id": str(attachment.id),
            "name": attachment.original_name,
            "mime_type": attachment.mime_type,
            "size_bytes": attachment.size_bytes,
        },
    }


@router.get("/me")
def get_my_chat_identity(current_user: User = Depends(get_current_user)):
    return {
        "user_id": str(current_user.id),
        "zyvano_id": current_user.zyvano_id,
        "name": current_user.name,
    }


@router.post("/conversations")
def start_conversation(
    payload: StartConversationRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    target = (
        db.query(User)
        .filter(User.zyvano_id == payload.zyvano_id.strip().upper())
        .first()
    )
    if not target or not target.is_active:
        raise HTTPException(status_code=404, detail="Zyvano user not found")
    if target.id == current_user.id:
        raise HTTPException(status_code=400, detail="You cannot start a conversation with yourself")

    one, two = sorted((current_user.id, target.id), key=str)
    conversation = (
        db.query(ChatConversation)
        .filter(
            ChatConversation.user_one_id == one,
            ChatConversation.user_two_id == two,
        )
        .first()
    )
    if not conversation:
        conversation = ChatConversation(user_one_id=one, user_two_id=two)
        db.add(conversation)
        db.commit()
        db.refresh(conversation)

    return {
        "id": str(conversation.id),
        "other_user": {
            "id": str(target.id),
            "zyvano_id": target.zyvano_id,
            "name": target.name,
        },
    }


@router.get("/conversations")
def list_conversations(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    rows = (
        db.query(ChatConversation)
        .filter(
            or_(
                ChatConversation.user_one_id == current_user.id,
                ChatConversation.user_two_id == current_user.id,
            )
        )
        .order_by(ChatConversation.updated_at.desc())
        .all()
    )
    result = []
    for conversation in rows:
        other = db.query(User).filter(User.id == conversation.other_user_id(current_user.id)).first()
        last = (
            db.query(ChatMessage)
            .filter(ChatMessage.conversation_id == conversation.id)
            .order_by(ChatMessage.created_at.desc(), ChatMessage.id.desc())
            .first()
        )
        result.append({
            "id": str(conversation.id),
            "other_user": {
                "id": str(other.id),
                "zyvano_id": other.zyvano_id,
                "name": other.name,
            },
            "last_message": _message_payload(db, last) if last else None,
            "updated_at": conversation.updated_at.isoformat(),
        })
    return result


@router.get("/conversations/{conversation_id}/messages")
def list_messages(
    conversation_id: UUID,
    before: datetime | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _conversation_or_404(db, current_user.id, conversation_id)
    query = db.query(ChatMessage).filter(ChatMessage.conversation_id == conversation_id)
    if before:
        query = query.filter(ChatMessage.created_at < before)
    rows = (
        query.order_by(ChatMessage.created_at.desc(), ChatMessage.id.desc())
        .limit(limit)
        .all()
    )
    return [_message_payload(db, row) for row in reversed(rows)]


@router.post("/conversations/{conversation_id}/attachments", status_code=201)
async def upload_attachment(
    conversation_id: UUID,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    storage: ChatStorage = Depends(get_chat_storage),
):
    conversation = _conversation_or_404(db, current_user.id, conversation_id)
    safe_name = (file.filename or "attachment").replace("/", "_").replace("\\", "_")[:255]
    content = await file.read(MAX_FILE_SIZE_BYTES + 1)
    if len(content) > MAX_FILE_SIZE_BYTES:
        raise HTTPException(status_code=413, detail="File exceeds the 100 MB chat attachment limit")

    path = f"chat/{conversation.id}/{uuid4()}-{safe_name}"
    await storage.upload(path, content, file.content_type or "application/octet-stream")
    attachment = ChatAttachment(
        conversation_id=conversation.id,
        uploader_id=current_user.id,
        storage_path=path,
        original_name=safe_name,
        mime_type=file.content_type or "application/octet-stream",
        size_bytes=len(content),
    )
    db.add(attachment)
    db.commit()
    db.refresh(attachment)
    return {
        "id": str(attachment.id),
        "name": attachment.original_name,
        "mime_type": attachment.mime_type,
        "size_bytes": attachment.size_bytes,
    }


@router.post("/conversations/{conversation_id}/messages", status_code=201)
async def send_message(
    conversation_id: UUID,
    payload: SendMessageRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    conversation = _conversation_or_404(db, current_user.id, conversation_id)
    body = payload.body.strip() if payload.body else None
    if not body and not payload.attachment_id:
        raise HTTPException(status_code=400, detail="Message must contain text or an attachment")

    if payload.attachment_id:
        attachment = (
            db.query(ChatAttachment)
            .filter(
                ChatAttachment.id == payload.attachment_id,
                ChatAttachment.conversation_id == conversation.id,
                ChatAttachment.uploader_id == current_user.id,
            )
            .first()
        )
        if not attachment:
            raise HTTPException(status_code=404, detail="Attachment not found")

    message = ChatMessage(
        conversation_id=conversation.id,
        sender_id=current_user.id,
        body=body,
        attachment_id=payload.attachment_id,
    )
    db.add(message)
    conversation.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(message)
    result = _message_payload(db, message)
    await manager.broadcast(conversation.id, result)
    return result


@router.post("/conversations/{conversation_id}/read")
def mark_read(
    conversation_id: UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _conversation_or_404(db, current_user.id, conversation_id)
    now = datetime.utcnow()
    (
        db.query(ChatMessage)
        .filter(
            ChatMessage.conversation_id == conversation_id,
            ChatMessage.sender_id != current_user.id,
            ChatMessage.read_at.is_(None),
        )
        .update({ChatMessage.read_at: now}, synchronize_session=False)
    )
    db.commit()
    return {"read_at": now.isoformat()}


@router.get("/attachments/{attachment_id}/url")
async def attachment_url(
    attachment_id: UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    storage: ChatStorage = Depends(get_chat_storage),
):
    attachment = db.query(ChatAttachment).filter(ChatAttachment.id == attachment_id).first()
    if not attachment:
        raise HTTPException(status_code=404, detail="Attachment not found")
    _conversation_or_404(db, current_user.id, attachment.conversation_id)
    return {
        "url": await storage.signed_download_url(attachment.storage_path, 900),
        "expires_in": 900,
    }


@router.websocket("/ws/{conversation_id}")
async def chat_socket(websocket: WebSocket, conversation_id: UUID, db: Session = Depends(get_db)):
    token = websocket.query_params.get("token")
    if not token:
        await websocket.close(code=4401)
        return

    token_data = verify_token(token)
    if not token_data:
        await websocket.close(code=4401)
        return

    _conversation_or_404(db, token_data.user_id, conversation_id)
    await manager.connect(conversation_id, websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(conversation_id, websocket)
