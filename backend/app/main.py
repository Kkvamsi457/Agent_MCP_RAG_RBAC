
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Optional

from bson import ObjectId
from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .schemas import ChatRequest, ChatResponse, RouteRequest, RouteResponse
from .agent import (
    answer,
    route,
    TOOL_LABELS,
    initialize_mcp,
    shutdown_mcp,
)
from .ingestion import ingest
from .config import DATA_DIR
from . import auth


@asynccontextmanager
async def lifespan(app: FastAPI):
    auth.seed_database()

    from seed_prompts import seed_prompts

    seed_prompts()
    await initialize_mcp()

    try:
        yield
    finally:
        await shutdown_mcp()


app = FastAPI(
    title="Atlas Agentic RAG Assistant",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=256)


class RegisterRequest(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=8, max_length=256)
    display_name: str = Field(min_length=1, max_length=120)
    role_code: str = Field(default="user", pattern=r"^(admin|user)$")


class PromptCreate(BaseModel):
    code: str = Field(
        min_length=2,
        max_length=80,
        pattern=r"^[a-zA-Z0-9_-]+$",
    )
    name: str = Field(min_length=2, max_length=160)
    category: str = Field(default="general", max_length=80)
    content: str = Field(min_length=1, max_length=30000)
    is_active: bool = True


class PromptUpdate(BaseModel):
    name: Optional[str] = Field(
        default=None, min_length=2, max_length=160
    )
    category: Optional[str] = Field(default=None, max_length=80)
    content: Optional[str] = Field(
        default=None, min_length=1, max_length=30000
    )
    is_active: Optional[bool] = None


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/auth/login")
def login(req: LoginRequest):
    user = auth.authenticate(req.username, req.password)

    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password.",
        )

    token = auth._issue(user)

    return {
        "access_token": token,
        "token_type": "bearer",
        "user": {
            "id": str(user["_id"]),
            "username": user["username"],
            "display_name": user.get(
                "display_name", user["username"]
            ),
            "role_code": user["role_code"],
            "role_name": user["role_name"],
        },
    }


@app.get("/api/auth/me")
def me(user=Depends(auth.current_user)):
    return user


def admin_user(user=Depends(auth.current_user)):
    return auth.require_admin(user, "read")


def prompt_create_user(user=Depends(auth.current_user)):
    return auth.require_admin(user, "create")


def prompt_update_user(user=Depends(auth.current_user)):
    return auth.require_admin(user, "update")


def prompt_delete_user(user=Depends(auth.current_user)):
    return auth.require_admin(user, "delete")


@app.post(
    "/api/auth/register",
    status_code=status.HTTP_201_CREATED,
)
def register(req: RegisterRequest, user=Depends(admin_user)):
    """
    Register a new user. Only an authenticated account with
    the prompts.read admin permission can use this endpoint.
    """
    return auth.register_user(
        username=req.username,
        password=req.password,
        display_name=req.display_name,
        role_code=req.role_code,
    )


@app.get("/api/prompts")
def list_prompts(user=Depends(admin_user)):
    return {
        "prompts": [
            {
                "id": str(p["_id"]),
                "code": p["code"],
                "name": p["name"],
                "category": p.get("category", "general"),
                "content": p["content"],
                "is_active": p.get("is_active", True),
                "updated_at": (
                    p["updated_at"].isoformat()
                    if p.get("updated_at")
                    else None
                ),
            }
            for p in auth.prompts.find({}).sort("code", 1)
        ]
    }


@app.post(
    "/api/prompts",
    status_code=status.HTTP_201_CREATED,
)
def create_prompt(
    req: PromptCreate,
    user=Depends(prompt_create_user),
):
    now = datetime.now(timezone.utc)
    doc = (
        req.model_dump()
        if hasattr(req, "model_dump")
        else req.dict()
    )

    doc.update({
        "created_at": now,
        "updated_at": now,
        "created_by": user["id"],
    })

    try:
        result = auth.prompts.insert_one(doc)
    except Exception as exc:
        if "duplicate" in str(exc).lower():
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="A prompt with this code already exists.",
            )
        raise

    return {
        "id": str(result.inserted_id),
        "message": "Prompt created.",
    }


@app.get("/api/prompts/{prompt_id}")
def get_prompt(prompt_id: str, user=Depends(admin_user)):
    try:
        oid = ObjectId(prompt_id)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Prompt not found.",
        )

    p = auth.prompts.find_one({"_id": oid})

    if not p:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Prompt not found.",
        )

    return {
        "id": str(p["_id"]),
        "code": p["code"],
        "name": p["name"],
        "category": p.get("category", "general"),
        "content": p["content"],
        "is_active": p.get("is_active", True),
    }


@app.put("/api/prompts/{prompt_id}")
def update_prompt(
    prompt_id: str,
    req: PromptUpdate,
    user=Depends(prompt_update_user),
):
    try:
        oid = ObjectId(prompt_id)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Prompt not found.",
        )

    changes = (
        req.model_dump(exclude_unset=True)
        if hasattr(req, "model_dump")
        else req.dict(exclude_unset=True)
    )

    if not changes:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No changes supplied.",
        )

    changes["updated_at"] = datetime.now(timezone.utc)

    result = auth.prompts.update_one(
        {"_id": oid},
        {"$set": changes},
    )

    if not result.matched_count:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Prompt not found.",
        )

    return {"message": "Prompt updated."}


@app.delete("/api/prompts/{prompt_id}")
def delete_prompt(
    prompt_id: str,
    user=Depends(prompt_delete_user),
):
    try:
        oid = ObjectId(prompt_id)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Prompt not found.",
        )

    result = auth.prompts.delete_one({"_id": oid})

    if not result.deleted_count:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Prompt not found.",
        )

    return {"message": "Prompt deleted."}


@app.post("/api/route", response_model=RouteResponse)
def route_query(
    req: RouteRequest,
    user=Depends(auth.current_user),
):
    try:
        plan = route(req.message, req.history)

        return {
            "tool": plan["tool"],
            "tool_label": TOOL_LABELS[plan["tool"]],
            "reason": plan.get("reason", ""),
            "input": plan.get("input") or req.message,
        }
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        )


@app.post("/api/ingest")
def run_ingest(user=Depends(admin_user)):
    try:
        return {"status": "ok", "chunks": ingest(force=True)}
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        )


@app.post("/api/chat", response_model=ChatResponse)
async def chat(
    req: ChatRequest,
    user=Depends(auth.current_user),
):
    try:
        return await answer(
            req.message,
            req.history,
            req.selected_tool,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        )


@app.get("/api/documents")
def documents(user=Depends(auth.current_user)):
    return {
        "documents": sorted(
            p.name for p in DATA_DIR.glob("*.pdf")
        )
    }
