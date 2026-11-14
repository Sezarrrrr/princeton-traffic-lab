from fastapi import FastAPI

app = FastAPI(title="Princeton Traffic Lab")


@app.get("/api/health")
def health_check():
    return {"status": "ok"}
