# Using a different agent framework

The starter repo ships a Node.js + Playwright runner, but AgentGauntlet is
**framework-agnostic**. Every scenario is a live web page. Any code that can
drive a real browser and call an HTTPS endpoint can participate.

This doc shows minimal skeletons for eight popular frameworks. Each skeleton
is **deliberately under-tuned** — same philosophy as the Node starter. Read
it, run it, then beat it.

---

## How the pieces fit together

```
┌─────────────────────────────────────────────┐
│  Your agent framework                        │
│  (LangGraph / ADK / CrewAI / Mastra / …)    │
│                                              │
│  decides WHAT to do based on LLM reasoning  │
└────────────────┬────────────────────────────┘
                 │  calls
┌────────────────▼────────────────────────────┐
│  Browser automation layer                    │
│  (Playwright Python or Node.js)              │
│                                              │
│  executes actions: click, type, screenshot   │
└────────────────┬────────────────────────────┘
                 │  drives
┌────────────────▼────────────────────────────┐
│  AgentGauntlet scenario page                 │
│  (live HTML — same page a human would see)   │
│                                              │
│  scores Layer 1–4 signals as you interact   │
└─────────────────────────────────────────────┘
```

**The agent framework is the brain. Playwright is the hands.**
The score comes from how human-like the hands look — not how smart the brain is.

---

## Prerequisites

### For Python frameworks

```bash
# Browser automation
pip install playwright
playwright install chromium

# Optional but highly recommended for async frameworks
pip install httpx

# Copy the Python API client into your project
# (from agent-gauntlet-starter/lib/agg-client.py or just paste the snippet below)
```

Drop `lib/agg-client.py` (from the starter repo) next to your agent code.
It mirrors the Node client: `whoami()`, `start_session()`, `session_result()`.

### For Node/TypeScript frameworks

You already have everything from the starter:
```bash
npm install          # Playwright + dotenv already in package.json
```

Add your framework on top:
```bash
npm install @ai-sdk/anthropic ai zod     # Vercel AI SDK example
# or: npm install @mastra/core @mastra/anthropic zod
```

---

## Quick reference

| Framework | Language | Pattern | Effort |
|---|---|---|---|
| Anthropic Claude Agent SDK | Python | Tool use | Low |
| LangGraph | Python | Graph nodes | Medium |
| OpenAI Agents SDK | Python | `@function_tool` | Low |
| CrewAI | Python | `BaseTool` subclass | Low |
| Smolagents | Python | `@tool` decorator | Low |
| Pydantic AI | Python | `@agent.tool` | Low |
| Vercel AI SDK | Node/TS | `tool()` + `generateText` | Low |
| Mastra | Node/TS | `createTool` | Low |

---

## 1 — Anthropic Claude Agent SDK

Install: `pip install anthropic playwright`

```python
"""
AgentGauntlet × Anthropic Claude Agent SDK
Minimal cart-checkout skeleton — deliberately under-tuned.
"""
import asyncio
import base64
import os
import sys

import anthropic
from dotenv import load_dotenv
from playwright.async_api import async_playwright

sys.path.insert(0, "lib")  # so we can import agg_client
import agg_client as agg

load_dotenv()

TOOLS = [
    {
        "name": "screenshot",
        "description": "Take a screenshot of the current page and return it as base64 PNG.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "click",
        "description": "Click the first element matching a CSS selector.",
        "input_schema": {
            "type": "object",
            "properties": {"selector": {"type": "string"}},
            "required": ["selector"],
        },
    },
    {
        "name": "done",
        "description": "Signal that the task is complete (or that you are stuck).",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
]


async def run_agent():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        context = await browser.new_context(
            viewport={"width": 1280, "height": 800},
            locale="en-US",
        )
        page = await context.new_page()

        # ── 1. Start a session ──────────────────────────────────────────────
        session = await asyncio.to_thread(agg.start_session, mode="cv")
        session_id = session["sessionId"]
        print(f"  session: {session_id}")

        await page.goto(session["scenarioUrl"], wait_until="networkidle")

        # ── 2. Run the agent loop ───────────────────────────────────────────
        client = anthropic.Anthropic()
        messages = [
            {"role": "user", "content": f"Complete this task: {session['tasks']}"}
        ]
        max_turns = 20

        for _ in range(max_turns):
            response = client.messages.create(
                model=os.environ.get("LLM_MODEL", "claude-sonnet-4-6"),
                max_tokens=1024,
                tools=TOOLS,
                messages=messages,
            )
            messages.append({"role": "assistant", "content": response.content})

            if response.stop_reason == "end_turn":
                break

            # Execute any tool calls
            tool_results = []
            finished = False
            for block in response.content:
                if block.type != "tool_use":
                    continue
                if block.name == "done":
                    finished = True
                    tool_results.append(
                        {"type": "tool_result", "tool_use_id": block.id, "content": "done"}
                    )
                elif block.name == "screenshot":
                    png = await page.screenshot(full_page=True)
                    b64 = base64.standard_b64encode(png).decode()
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": [{"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": b64}}],
                    })
                elif block.name == "click":
                    try:
                        # ⚠️  No deliberation pause — synthetic_click_dwell fires.
                        # Add await page.hover(block.input["selector"]) + sleep.
                        await page.click(block.input["selector"], timeout=8000)
                        tool_results.append(
                            {"type": "tool_result", "tool_use_id": block.id, "content": "clicked"}
                        )
                    except Exception as e:
                        tool_results.append(
                            {"type": "tool_result", "tool_use_id": block.id, "content": f"error: {e}", "is_error": True}
                        )

            messages.append({"role": "user", "content": tool_results})
            if finished:
                break

        await browser.close()

        # ── 3. Always print the result ──────────────────────────────────────
        result = await asyncio.to_thread(agg.session_result, session_id)
        print(f"  outcome:    {result['outcome']}")
        print(f"  risk_score: {result['risk_score']} ({result['risk_tier']})")
        signals = result.get("signal_counts", {})
        if signals:
            print("  signals:", ", ".join(f"{k}:{v}" for k, v in signals.items()))
        return session_id


if __name__ == "__main__":
    asyncio.run(run_agent())
```

---

## 2 — LangGraph

Install: `pip install langgraph langchain-anthropic playwright`

```python
"""
AgentGauntlet × LangGraph
Observe → Decide → Act graph for cart-checkout.
"""
import asyncio
import base64
import operator
import os
import sys
from typing import Annotated, TypedDict

from dotenv import load_dotenv
from langchain_anthropic import ChatAnthropic
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.tools import tool
from langgraph.graph import END, StateGraph
from playwright.sync_api import sync_playwright

sys.path.insert(0, "lib")
import agg_client as agg

load_dotenv()

# ── Shared browser (initialised in main) ────────────────────────────────────
_page = None


# ── Tools (browser actions as LangChain tools) ──────────────────────────────
@tool
def screenshot() -> str:
    """Take a screenshot. Returns base64 PNG."""
    png = _page.screenshot(full_page=True)
    return base64.standard_b64encode(png).decode()


@tool
def click(selector: str) -> str:
    """Click the first element matching selector."""
    # ⚠️  No deliberation — add hover + sleep to silence synthetic_click_dwell
    _page.click(selector, timeout=8000)
    return f"clicked: {selector}"


@tool
def fill(selector: str, text: str) -> str:
    """Type text into an input field."""
    # ⚠️  uniform_keystroke_timing fires — vary delays in your real agent
    _page.fill(selector, text)
    return f"filled: {selector}"


TOOLS = [screenshot, click, fill]
llm = ChatAnthropic(
    model=os.environ.get("LLM_MODEL", "claude-sonnet-4-6"),
    api_key=os.environ.get("LLM_API_KEY"),
).bind_tools(TOOLS)


# ── Graph state ──────────────────────────────────────────────────────────────
class State(TypedDict):
    messages: Annotated[list, operator.add]
    session_id: str
    done: bool


# ── Nodes ────────────────────────────────────────────────────────────────────
def agent_node(state: State) -> dict:
    response = llm.invoke(state["messages"])
    return {"messages": [response]}


def tool_node(state: State) -> dict:
    from langchain_core.messages import ToolMessage
    last = state["messages"][-1]
    results = []
    for call in last.tool_calls:
        fn = {t.name: t for t in TOOLS}[call["name"]]
        try:
            out = fn.invoke(call["args"])
        except Exception as e:
            out = f"error: {e}"
        results.append(ToolMessage(content=str(out), tool_call_id=call["id"]))
    return {"messages": results}


def should_continue(state: State) -> str:
    last = state["messages"][-1]
    if not getattr(last, "tool_calls", None):
        return END
    return "tools"


# ── Build graph ──────────────────────────────────────────────────────────────
graph = StateGraph(State)
graph.add_node("agent", agent_node)
graph.add_node("tools", tool_node)
graph.set_entry_point("agent")
graph.add_conditional_edges("agent", should_continue)
graph.add_edge("tools", "agent")
compiled = graph.compile()


# ── Runner ───────────────────────────────────────────────────────────────────
def run():
    global _page
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1280, "height": 800})
        _page = context.new_page()

        session = agg.start_session(mode="cv")
        session_id = session["sessionId"]
        print(f"  session: {session_id}")
        _page.goto(session["scenarioUrl"], wait_until="networkidle")

        initial = {
            "messages": [
                SystemMessage(content="You control a browser. Complete the task using the tools."),
                HumanMessage(content=f"Task: {session['tasks']}"),
            ],
            "session_id": session_id,
            "done": False,
        }
        compiled.invoke(initial)
        browser.close()

    result = agg.session_result(session_id)
    print(f"  outcome:    {result['outcome']}")
    print(f"  risk_score: {result['risk_score']} ({result['risk_tier']})")
    signals = result.get("signal_counts", {})
    if signals:
        print("  signals:", ", ".join(f"{k}:{v}" for k, v in signals.items()))


if __name__ == "__main__":
    run()
```

---

## 3 — OpenAI Agents SDK

Install: `pip install openai-agents playwright`

```python
"""
AgentGauntlet × OpenAI Agents SDK
"""
import asyncio
import base64
import os
import sys

from agents import Agent, Runner, function_tool
from dotenv import load_dotenv
from playwright.async_api import async_playwright

sys.path.insert(0, "lib")
import agg_client as agg

load_dotenv()

# ── Shared page reference ────────────────────────────────────────────────────
_page = None


@function_tool
async def take_screenshot() -> str:
    """Capture the current page as base64 PNG for visual inspection."""
    png = await _page.screenshot(full_page=True)
    return base64.standard_b64encode(png).decode()


@function_tool
async def click_element(selector: str) -> str:
    """Click the first DOM element matching a CSS selector."""
    # ⚠️  Add hover + asyncio.sleep for synthetic_click_dwell
    await _page.click(selector, timeout=8000)
    return f"clicked {selector}"


@function_tool
async def type_text(selector: str, text: str) -> str:
    """Type text into a form field identified by CSS selector."""
    await _page.fill(selector, text)
    return f"typed into {selector}"


AGENT = Agent(
    name="cart-checkout",
    model=os.environ.get("LLM_MODEL", "gpt-4o"),
    instructions=(
        "You are a browser automation agent. Use the provided tools to complete "
        "the checkout task. Call take_screenshot first to see what's on screen."
    ),
    tools=[take_screenshot, click_element, type_text],
)


async def run():
    global _page
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1280, "height": 800})
        _page = await context.new_page()

        session = await asyncio.to_thread(agg.start_session, mode="cv")
        session_id = session["sessionId"]
        print(f"  session: {session_id}")
        await _page.goto(session["scenarioUrl"], wait_until="networkidle")

        result_obj = await Runner.run(AGENT, input=f"Task: {session['tasks']}")
        print(f"  agent final output: {result_obj.final_output}")
        await browser.close()

    result = await asyncio.to_thread(agg.session_result, session_id)
    print(f"  outcome:    {result['outcome']}")
    print(f"  risk_score: {result['risk_score']} ({result['risk_tier']})")
    signals = result.get("signal_counts", {})
    if signals:
        print("  signals:", ", ".join(f"{k}:{v}" for k, v in signals.items()))


if __name__ == "__main__":
    asyncio.run(run())
```

---

## 4 — CrewAI

Install: `pip install crewai playwright`

```python
"""
AgentGauntlet × CrewAI
Single-agent crew for cart-checkout.
"""
import base64
import os
import sys

from crewai import Agent, Crew, Task
from crewai.tools import BaseTool
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

sys.path.insert(0, "lib")
import agg_client as agg

load_dotenv()

_page = None  # set in main()


class ScreenshotTool(BaseTool):
    name: str = "screenshot"
    description: str = "Capture the current page as a base64 PNG."

    def _run(self) -> str:
        return base64.standard_b64encode(_page.screenshot(full_page=True)).decode()


class ClickTool(BaseTool):
    name: str = "click"
    description: str = "Click a DOM element by CSS selector. Input: CSS selector string."

    def _run(self, selector: str) -> str:
        # ⚠️  No dwell — add page.hover + sleep to reduce synthetic_click_dwell
        _page.click(selector, timeout=8000)
        return f"clicked: {selector}"


class FillTool(BaseTool):
    name: str = "fill"
    description: str = "Fill a text input. Input JSON: {selector, text}"

    def _run(self, selector: str, text: str) -> str:
        _page.fill(selector, text)
        return f"filled {selector}"


browser_agent = Agent(
    role="Browser Automation Specialist",
    goal="Complete web tasks by controlling a browser step by step.",
    backstory="Expert at navigating web UIs, avoiding traps, and filling forms accurately.",
    tools=[ScreenshotTool(), ClickTool(), FillTool()],
    llm=f"anthropic/claude-sonnet-4-6",  # or openai/gpt-4o
    verbose=True,
)


def run():
    global _page
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        _page = browser.new_context(viewport={"width": 1280, "height": 800}).new_page()

        session = agg.start_session(mode="cv")
        session_id = session["sessionId"]
        print(f"  session: {session_id}")
        _page.goto(session["scenarioUrl"], wait_until="networkidle")

        task = Task(
            description=f"Complete this checkout task: {session['tasks']}",
            expected_output="Confirmation that the task is done or a description of where it got stuck.",
            agent=browser_agent,
        )
        crew = Crew(agents=[browser_agent], tasks=[task], verbose=True)
        crew.kickoff()
        browser.close()

    result = agg.session_result(session_id)
    print(f"  outcome:    {result['outcome']}")
    print(f"  risk_score: {result['risk_score']} ({result['risk_tier']})")
    signals = result.get("signal_counts", {})
    if signals:
        print("  signals:", ", ".join(f"{k}:{v}" for k, v in signals.items()))


if __name__ == "__main__":
    run()
```

---

## 5 — Smolagents (HuggingFace)

Install: `pip install smolagents playwright`

```python
"""
AgentGauntlet × Smolagents
Minimal CodeAgent with browser tools.
"""
import base64
import os
import sys

from dotenv import load_dotenv
from playwright.sync_api import sync_playwright
from smolagents import CodeAgent, LiteLLMModel, tool

sys.path.insert(0, "lib")
import agg_client as agg

load_dotenv()

_page = None  # set in main()


@tool
def screenshot() -> str:
    """Take a screenshot of the current browser page. Returns base64 PNG string."""
    return base64.standard_b64encode(_page.screenshot(full_page=True)).decode()


@tool
def click(selector: str) -> str:
    """Click a DOM element by CSS selector.

    Args:
        selector: CSS selector for the element to click (e.g. "#submit-btn")
    """
    # ⚠️  Instant click fires synthetic_click_dwell. Add hover + sleep.
    _page.click(selector, timeout=8000)
    return f"clicked: {selector}"


@tool
def fill_input(selector: str, text: str) -> str:
    """Fill a form input with text.

    Args:
        selector: CSS selector for the input field
        text: Text to type into the field
    """
    _page.fill(selector, text)
    return f"filled {selector} with '{text}'"


def run():
    global _page
    model = LiteLLMModel(
        model_id=f"anthropic/{os.environ.get('LLM_MODEL', 'claude-sonnet-4-6')}",
        api_key=os.environ.get("LLM_API_KEY"),
    )
    # ⚠️  CodeAgent can execute arbitrary Python — that's its power.
    # It'll call your tools in generated code, so tool docstrings matter.
    agent = CodeAgent(tools=[screenshot, click, fill_input], model=model, max_steps=20)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        _page = browser.new_context(viewport={"width": 1280, "height": 800}).new_page()

        session = agg.start_session(mode="cv")
        session_id = session["sessionId"]
        print(f"  session: {session_id}")
        _page.goto(session["scenarioUrl"], wait_until="networkidle")

        agent.run(
            f"Complete this web task using the browser tools: {session['tasks']}. "
            "Start by taking a screenshot to see what's on screen."
        )
        browser.close()

    result = agg.session_result(session_id)
    print(f"  outcome:    {result['outcome']}")
    print(f"  risk_score: {result['risk_score']} ({result['risk_tier']})")
    signals = result.get("signal_counts", {})
    if signals:
        print("  signals:", ", ".join(f"{k}:{v}" for k, v in signals.items()))


if __name__ == "__main__":
    run()
```

---

## 6 — Pydantic AI

Install: `pip install pydantic-ai playwright`

```python
"""
AgentGauntlet × Pydantic AI
Async agent with typed tool signatures.
"""
import asyncio
import base64
import os
import sys

from dotenv import load_dotenv
from playwright.async_api import async_playwright
from pydantic_ai import Agent
from pydantic_ai.models.anthropic import AnthropicModel

sys.path.insert(0, "lib")
import agg_client as agg

load_dotenv()

# ── Agent definition ─────────────────────────────────────────────────────────
model = AnthropicModel(
    os.environ.get("LLM_MODEL", "claude-sonnet-4-6"),
    api_key=os.environ.get("LLM_API_KEY"),
)
agent: Agent[None, str] = Agent(
    model,
    system_prompt=(
        "You control a browser. Use the tools to complete the task. "
        "Always screenshot first to see current state."
    ),
)

# ── Shared page — set before running ─────────────────────────────────────────
_page = None


@agent.tool_plain
async def screenshot() -> str:
    """Take a full-page screenshot. Returns base64 PNG."""
    png = await _page.screenshot(full_page=True)
    return base64.standard_b64encode(png).decode()


@agent.tool_plain
async def click(selector: str) -> str:
    """Click the first element matching a CSS selector.

    Args:
        selector: CSS selector string, e.g. '#submit-btn' or 'button.primary'
    """
    # ⚠️  Add await _page.hover(selector) + asyncio.sleep(0.3) for realism
    await _page.click(selector, timeout=8000)
    return f"clicked: {selector}"


@agent.tool_plain
async def fill_field(selector: str, text: str) -> str:
    """Type text into a form field.

    Args:
        selector: CSS selector for the input
        text: Text to enter
    """
    await _page.fill(selector, text)
    return f"filled {selector}"


# ── Runner ───────────────────────────────────────────────────────────────────
async def run():
    global _page
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        _page = await browser.new_context(
            viewport={"width": 1280, "height": 800}
        ).new_page()

        session = await asyncio.to_thread(agg.start_session, mode="cv")
        session_id = session["sessionId"]
        print(f"  session: {session_id}")
        await _page.goto(session["scenarioUrl"], wait_until="networkidle")

        result_obj = await agent.run(f"Complete this task: {session['tasks']}")
        print(f"  agent result: {result_obj.data}")
        await browser.close()

    result = await asyncio.to_thread(agg.session_result, session_id)
    print(f"  outcome:    {result['outcome']}")
    print(f"  risk_score: {result['risk_score']} ({result['risk_tier']})")
    signals = result.get("signal_counts", {})
    if signals:
        print("  signals:", ", ".join(f"{k}:{v}" for k, v in signals.items()))


if __name__ == "__main__":
    asyncio.run(run())
```

---

## 7 — Vercel AI SDK (Node.js / TypeScript)

Install: `npm install ai @ai-sdk/anthropic zod`

```typescript
// agents/cart-checkout-vercel.ts
// AgentGauntlet × Vercel AI SDK
// Run: npx tsx agents/cart-checkout-vercel.ts

import { generateText, tool } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { chromium } from "playwright";
import { z } from "zod";
import "dotenv/config";

import aggClient from "../lib/agg-client.js";

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  // ── 1. Start a session ───────────────────────────────────────────────────
  const sessionRes = await aggClient.authedFetch("/api/v2/session", {
    method: "POST",
    body: JSON.stringify({ mode: "cv" }),
  });
  const session = await sessionRes.json();
  console.log(`  session: ${session.sessionId}`);
  await page.goto(session.scenarioUrl, { waitUntil: "networkidle" });

  // ── 2. Define browser tools ──────────────────────────────────────────────
  const tools = {
    screenshot: tool({
      description: "Take a screenshot. Returns base64 PNG.",
      parameters: z.object({}),
      execute: async () => {
        const buf = await page.screenshot({ fullPage: true });
        return buf.toString("base64");
      },
    }),
    click: tool({
      description: "Click a DOM element by CSS selector.",
      parameters: z.object({ selector: z.string().describe("CSS selector") }),
      execute: async ({ selector }) => {
        // ⚠️  Add page.hover(selector) + sleep for synthetic_click_dwell
        await page.click(selector, { timeout: 8000 });
        return `clicked: ${selector}`;
      },
    }),
    fill: tool({
      description: "Type text into an input field.",
      parameters: z.object({
        selector: z.string(),
        text: z.string(),
      }),
      execute: async ({ selector, text }) => {
        await page.fill(selector, text);
        return `filled ${selector}`;
      },
    }),
  };

  // ── 3. Run the agent loop ────────────────────────────────────────────────
  const { text } = await generateText({
    model: anthropic(process.env.LLM_MODEL ?? "claude-sonnet-4-6"),
    system: "You control a browser. Use tools to complete the task.",
    prompt: `Complete this task: ${JSON.stringify(session.tasks)}`,
    tools,
    maxSteps: 20,
  });
  console.log(`  agent output: ${text}`);

  await browser.close();

  // ── 4. Print result ──────────────────────────────────────────────────────
  const result = await aggClient.sessionResult(session.sessionId);
  console.log(`  outcome:    ${result.outcome}`);
  console.log(`  risk_score: ${result.risk_score} (${result.risk_tier})`);
  const signals = result.signal_counts ?? {};
  if (Object.keys(signals).length) {
    console.log("  signals:", Object.entries(signals).map(([k, v]) => `${k}:${v}`).join(", "));
  }
}

run().catch(console.error);
```

---

## 8 — Mastra (Node.js / TypeScript)

Install: `npm install @mastra/core @mastra/anthropic zod`

```typescript
// agents/cart-checkout-mastra.ts
// AgentGauntlet × Mastra
// Run: npx tsx agents/cart-checkout-mastra.ts

import { Agent, createTool } from "@mastra/core";
import { anthropic } from "@mastra/anthropic";
import { chromium, type Page } from "playwright";
import { z } from "zod";
import "dotenv/config";

import aggClient from "../lib/agg-client.js";

// ── Shared page ref (set before agent runs) ───────────────────────────────
let page: Page;

const screenshotTool = createTool({
  id: "screenshot",
  description: "Take a full-page screenshot. Returns base64 PNG.",
  inputSchema: z.object({}),
  execute: async () => {
    const buf = await page.screenshot({ fullPage: true });
    return { base64: buf.toString("base64") };
  },
});

const clickTool = createTool({
  id: "click",
  description: "Click a DOM element by CSS selector.",
  inputSchema: z.object({ selector: z.string() }),
  execute: async ({ context }) => {
    // ⚠️  No dwell — add page.hover + sleep to silence synthetic_click_dwell
    await page.click(context.selector, { timeout: 8000 });
    return { result: `clicked: ${context.selector}` };
  },
});

const fillTool = createTool({
  id: "fill",
  description: "Fill a text input identified by CSS selector.",
  inputSchema: z.object({ selector: z.string(), text: z.string() }),
  execute: async ({ context }) => {
    await page.fill(context.selector, context.text);
    return { result: `filled: ${context.selector}` };
  },
});

const browserAgent = new Agent({
  name: "cart-checkout",
  instructions:
    "You control a browser. Use tools to complete the assigned checkout task. Screenshot first.",
  model: anthropic(process.env.LLM_MODEL ?? "claude-sonnet-4-6"),
  tools: { screenshotTool, clickTool, fillTool },
});

async function run() {
  const browser = await chromium.launch({ headless: true });
  page = await browser.newContext({ viewport: { width: 1280, height: 800 } }).then(c => c.newPage());

  const sessionRes = await aggClient.authedFetch("/api/v2/session", {
    method: "POST",
    body: JSON.stringify({ mode: "cv" }),
  });
  const session = await sessionRes.json();
  console.log(`  session: ${session.sessionId}`);
  await page.goto(session.scenarioUrl, { waitUntil: "networkidle" });

  const response = await browserAgent.generate(
    `Complete this task: ${JSON.stringify(session.tasks)}`
  );
  console.log(`  agent output: ${response.text}`);

  await browser.close();

  const result = await aggClient.sessionResult(session.sessionId);
  console.log(`  outcome:    ${result.outcome}`);
  console.log(`  risk_score: ${result.risk_score} (${result.risk_tier})`);
  const signals = result.signal_counts ?? {};
  if (Object.keys(signals).length) {
    console.log("  signals:", Object.entries(signals).map(([k, v]) => `${k}:${v}`).join(", "));
  }
}

run().catch(console.error);
```

---

## Common pitfalls across all frameworks

### The tool abstraction leaks timing

Every framework eventually calls `page.click()`. That click fires
`synthetic_click_dwell` if it lands in <20ms after the page becomes interactive.
The fix is the same regardless of framework: **hover first, sleep, then click**.

```python
# Python — works in any framework that owns the page ref
await page.hover(selector)
await asyncio.sleep(random.uniform(0.2, 0.5))
await page.click(selector)
```

```js
// Node — same idea
await page.hover(selector);
await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
await page.click(selector);
```

### Screenshot tokens add up

Vision calls on full-page screenshots can be 1,000–3,000 tokens each. Either:
- Clip to the relevant viewport: `page.screenshot({ clip: { x, y, width, height } })`
- Or use DOM-only mode (`mode: "json"`) where the session payload already
  contains the task data as structured text — no screenshot needed.

### Async vs sync Playwright

Python's `playwright.sync_api` blocks the thread. For fully async frameworks
(ADK, Pydantic AI) use `playwright.async_api` — it's the same API, all methods
become `await`-able.

### Hermes models (Nous Research)

"Hermes" refers to fine-tuned model weights, not a framework. Run them via
Ollama or vLLM and use them as the LLM backend inside any framework above:

```python
# Smolagents example with a local Hermes model
model = LiteLLMModel(model_id="ollama/hermes-3-llama-3.1-8b", api_base="http://localhost:11434")
```

```python
# LangGraph example
from langchain_community.chat_models import ChatOllama
llm = ChatOllama(model="hermes-3-llama-3.1-8b").bind_tools(TOOLS)
```

---

## What you should still improve

These skeletons are intentionally raw. After you get a first run:

1. **Add deliberation pauses** — `synthetic_click_dwell` will fire without hover + sleep
2. **Strip `navigator.webdriver`** — add `addInitScript` before the first page load (see Lab 3)
3. **Set a real viewport** — `1280×800` → try `1440×900` or `1920×1080`
4. **Vary typing delays** — uniform `page.fill()` fires `uniform_keystroke_timing`
5. **Check for honeypots before clicking** — `element.offsetParent !== null` test in JS or
   `page.evaluate("el => el.offsetParent !== null", locator)` from Python

See [02-anti-detection-cookbook.md](02-anti-detection-cookbook.md) for full recipes,
and [labs/03-fix-a-fingerprint-signal.md](labs/03-fix-a-fingerprint-signal.md) for a
step-by-step walkthrough of the most impactful first fix.
