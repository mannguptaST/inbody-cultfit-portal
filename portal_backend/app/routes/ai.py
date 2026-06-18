"""
ai.py — AI Engineer chat endpoint.

POST /api/v1/ai/chat  — send a message, get an AI response with live Odoo data
GET  /api/v1/ai/tools — list available tools (for debugging)
"""

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services.ai_engine import get_ai_engine

logger = logging.getLogger(__name__)
router = APIRouter()


class ChatRequest(BaseModel):
    message: str
    history: list[dict] = []  # optional conversation history for multi-turn


class ChatResponse(BaseModel):
    answer: str
    tool_calls: list[dict] = []
    rounds: int = 0


@router.post("/ai/chat", response_model=ChatResponse, summary="AI Engineer: ask anything about Odoo")
async def ai_chat(body: ChatRequest):
    if not body.message.strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty.")

    engine = get_ai_engine()
    if not engine.client.api_key:
        raise HTTPException(
            status_code=503,
            detail="ANTHROPIC_API_KEY is not configured. Add it to your .env file.",
        )

    try:
        result = await engine.chat(
            user_message=body.message,
            conversation_history=body.history,
        )
        return ChatResponse(**result)
    except Exception as e:
        logger.error("AI chat error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/ai/tools", summary="AI Engineer: list available Odoo tools")
async def list_tools():
    from app.services.odoo_tools import ODOO_TOOL_DEFINITIONS
    return {
        "tools": [
            {"name": t["name"], "description": t["description"]}
            for t in ODOO_TOOL_DEFINITIONS
        ]
    }
