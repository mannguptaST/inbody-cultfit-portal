"""
ai_engine.py — Claude AI orchestration with tool use.

Flow for each user message:
  1. Build system prompt with Odoo context
  2. Send message + tools to Claude
  3. Claude may call tools (Odoo queries, RAG search)
  4. Execute each tool, send results back to Claude
  5. Claude produces final answer
  6. Return answer to user

This loop repeats until Claude stops calling tools.
"""

import json
import logging
from typing import Any

import anthropic

from app.config import get_settings
from app.services.odoo_tools import ODOO_TOOL_DEFINITIONS, execute_tool

logger = logging.getLogger(__name__)
settings = get_settings()

SYSTEM_PROMPT = """You are the InBody AI Engineer — an expert assistant for InBody India's Odoo ERP system.

You have access to live Odoo data and can answer any question about:
- Sales orders and their stages
- Customer/partner information
- Payment status and overdue orders
- Business reports and summaries
- Odoo module structure and fields
- How the InBody portal works

InBody India sells body composition analyzers (BCA devices) to B2B clients like gyms and fitness centres.
Key business context:
- Orders go through 9 stages: Order Received → PI Issued → PO Received → MD Approved → Dispatched → Installation Confirmed → Vendor Uploaded → Mail Sent → Payment Collected
- COCO orders: customer pays InBody directly (prices visible)
- FOFO orders: franchise model, prices are confidential
- Payment due: 90 days from vendor portal upload date
- Currency: Indian Rupee (INR / ₹)

When answering:
- Use tools to get real data before answering
- Format numbers with Indian number system (lakhs, crores) when appropriate
- Be concise but complete
- For reports, structure the output clearly with headers and tables where helpful
- If asked to generate a report, return it in a well-formatted markdown table
"""


class AIEngine:
    def __init__(self):
        self.client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)
        self.model = "claude-sonnet-4-6"
        self.max_tokens = 4096
        self.max_tool_rounds = 5  # prevent infinite loops

    async def chat(
        self,
        user_message: str,
        conversation_history: list[dict] | None = None,
    ) -> dict[str, Any]:
        """
        Main entry point. Takes a user message, orchestrates tool calls,
        returns the final answer and tool usage log.
        """
        messages = list(conversation_history or [])
        messages.append({"role": "user", "content": user_message})

        tool_log: list[dict] = []
        rounds = 0

        while rounds < self.max_tool_rounds:
            rounds += 1
            logger.info("AI round %d — sending to Claude", rounds)

            response = self.client.messages.create(
                model=self.model,
                max_tokens=self.max_tokens,
                system=SYSTEM_PROMPT,
                tools=ODOO_TOOL_DEFINITIONS,
                messages=messages,
            )

            # If Claude is done (no more tool calls), return its text
            if response.stop_reason == "end_turn":
                final_text = _extract_text(response.content)
                return {
                    "answer": final_text,
                    "tool_calls": tool_log,
                    "rounds": rounds,
                }

            # Claude wants to call tools
            if response.stop_reason == "tool_use":
                # Add Claude's response (with tool_use blocks) to history
                messages.append({"role": "assistant", "content": response.content})

                # Execute each tool Claude requested
                tool_results = []
                for block in response.content:
                    if block.type != "tool_use":
                        continue

                    tool_name = block.name
                    tool_input = block.input
                    logger.info("Claude calling tool: %s with %s", tool_name, tool_input)

                    result = execute_tool(tool_name, tool_input)
                    tool_log.append({
                        "tool": tool_name,
                        "input": tool_input,
                        "result_preview": str(result)[:200],
                    })

                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": json.dumps(result),
                    })

                # Send all tool results back to Claude in one message
                messages.append({"role": "user", "content": tool_results})
                continue

            # Unexpected stop reason
            logger.warning("Unexpected stop_reason: %s", response.stop_reason)
            break

        return {
            "answer": "I reached the maximum number of reasoning steps. Please try a simpler question.",
            "tool_calls": tool_log,
            "rounds": rounds,
        }


def _extract_text(content_blocks: list) -> str:
    """Pull all text blocks from Claude's response."""
    parts = []
    for block in content_blocks:
        if hasattr(block, "type") and block.type == "text":
            parts.append(block.text)
    return "\n".join(parts).strip()


# Singleton instance
_engine: AIEngine | None = None


def get_ai_engine() -> AIEngine:
    global _engine
    if _engine is None:
        _engine = AIEngine()
    return _engine
