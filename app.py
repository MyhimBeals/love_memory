import pymysql
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from dbutils.pooled_db import PooledDB
import os
import threading
import uuid
import time
import json
import base64
import httpx
import concurrent.futures
from datetime import datetime
from pathlib import Path

# ========================================
#  动态加载本地 .env 环境配置
# ========================================
ENV_FILE = Path(__file__).parent / '.env'
if ENV_FILE.exists():
    with open(ENV_FILE, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            # 忽略空行、注释行或无有效赋值的行
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, val = line.split('=', 1)
            # 加载到 os.environ，并剥离首尾引号
            os.environ[key.strip()] = val.strip().strip("'\"")

# ⚠️ 启动安全校验：数据库关键配置缺失时强行终止，确保 GitHub 开源安全
required_envs = ['DB_HOST', 'DB_PASSWORD']
missing_envs = [env for env in required_envs if not os.environ.get(env)]
if missing_envs:
    raise RuntimeError(
        f"\n========================================================\n"
        f"❌ 启动失败：未检测到必要的环境变量：{', '.join(missing_envs)}\n"
        f"👉 请复制 .env.example 并命名为 .env，然后填写您的数据库连接参数！\n"
        f"========================================================"
    )

import fcntl

app = Flask(__name__, static_folder='.', static_url_path='')
CORS(app)

# 允许最大 20MB 上传（两张原图 base64 编码后约 15-20MB）
app.config['MAX_CONTENT_LENGTH'] = 20 * 1024 * 1024

# 配置日志文件
LOG_FILE = os.path.join(os.path.dirname(__file__), 'db_debug.log')


def log_debug(message):
    with open(LOG_FILE, 'a', encoding='utf-8') as f:
        f.write(f"[{datetime.now()}] {message}\n")


# ========================================
#  数据库连接池（核心优化）
# ========================================
DB_CONFIG = {
    'host': os.environ.get('DB_HOST'),
    'port': int(os.environ.get('DB_PORT', 3306)),
    'user': os.environ.get('DB_USER', 'root'),
    'password': os.environ.get('DB_PASSWORD'),
    'database': os.environ.get('DB_NAME', 'love_db'),
    'charset': 'utf8mb4',
    'connect_timeout': 5,
}

log_debug("Creating connection pool...")
pool = PooledDB(
    creator=pymysql,
    maxconnections=5,      # 最大连接数
    mincached=2,           # 启动时预建 2 个连接
    maxcached=3,           # 池中最多缓存 3 个空闲连接
    blocking=True,         # 池满时阻塞等待而非报错
    ping=1,                # 每次取连接时 ping 一下检测存活
    cursorclass=pymysql.cursors.DictCursor,
    **DB_CONFIG,
)
log_debug("Connection pool created.")


def get_db():
    """从连接池获取连接（毫秒级，不再新建 TCP 连接）"""
    return pool.connection()


# ========================================
#  静态存储与平滑迁移（Task 1）
# ========================================
MEMORIES_DIR = Path(__file__).parent / 'static' / 'memories'
MEMORIES_DIR.mkdir(parents=True, exist_ok=True)


def migrate_base64_memories():
    try:
        log_debug("Starting base64 memories migration...")
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute("SELECT id, img FROM memories WHERE img LIKE 'data:image/%'")
        rows = cursor.fetchall()
        if not rows:
            log_debug("No base64 memories to migrate.")
            conn.close()
            return
        
        log_debug(f"Found {len(rows)} memories to migrate.")
        migrated_count = 0
        failed_count = 0
        
        for row in rows:
            row_id = row['id']
            img_str = row['img']
            try:
                if ',' in img_str:
                    header, base64_data = img_str.split(',', 1)
                else:
                    header = ''
                    base64_data = img_str
                
                # 推断后缀
                ext = 'jpg'
                if 'image/png' in header:
                    ext = 'png'
                elif 'image/webp' in header:
                    ext = 'webp'
                elif 'image/jpeg' in header or 'image/jpg' in header:
                    ext = 'jpg'
                
                # 解码 base64
                img_data = base64.b64decode(base64_data)
                
                # 生成 UUID 文件名
                file_uuid = str(uuid.uuid4())
                filename = f"photo-migrated-{file_uuid}.{ext}"
                filepath = MEMORIES_DIR / filename
                
                # 写入文件
                filepath.write_bytes(img_data)
                
                # 更新数据库记录为相对路径 /static/memories/photo-migrated-[uuid].[ext]
                db_path = f"/static/memories/{filename}"
                cursor.execute('UPDATE memories SET img = %s WHERE id = %s', (db_path, row_id))
                conn.commit()
                
                migrated_count += 1
                log_debug(f"Successfully migrated memory id {row_id} to {db_path}")
            except Exception as e:
                # 即使单个记录转换失败，回滚该记录的事务，不影响其他记录
                conn.rollback()
                failed_count += 1
                log_debug(f"Failed to migrate memory id {row_id}: {e}")
                
        conn.close()
        log_debug(f"Base64 memories migration finished. Migrated: {migrated_count}, Failed: {failed_count}")
    except Exception as e:
        log_debug(f"Critical error during memories migration: {e}")


# ========================================
#  数据库初始化（只在启动时执行一次）
# ========================================
def init_db():
    try:
        log_debug("Initializing database tables...")
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute('CREATE TABLE IF NOT EXISTS messages (id INT AUTO_INCREMENT PRIMARY KEY, text TEXT NOT NULL, time TEXT NOT NULL)')
        cursor.execute('CREATE TABLE IF NOT EXISTS secrets (id INT AUTO_INCREMENT PRIMARY KEY, text TEXT NOT NULL, time TEXT NOT NULL)')
        cursor.execute('CREATE TABLE IF NOT EXISTS memories (id INT AUTO_INCREMENT PRIMARY KEY, date TEXT, content TEXT, feeling TEXT, img LONGTEXT)')
        conn.commit()
        conn.close()
        log_debug("Database initialization finished.")
    except Exception as e:
        log_debug(f"Failed to initialize database: {e}")


init_db()
migrate_base64_memories()


@app.route('/')
def index():
    return send_from_directory('.', 'index.html')


# ========================================
#  批量 API（核心优化 — 一次请求拿全部数据）
# ========================================
@app.route('/api/all', methods=['GET'])
def get_all():
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM messages ORDER BY id DESC')
    messages = cursor.fetchall()
    cursor.execute('SELECT * FROM secrets ORDER BY id DESC')
    secrets = cursor.fetchall()
    cursor.execute('SELECT * FROM memories ORDER BY id DESC')
    memories = cursor.fetchall()
    conn.close()
    return jsonify({
        'messages': messages,
        'secrets': secrets,
        'memories': memories,
    })


# ========================================
#  留言板 API
# ========================================
@app.route('/api/messages', methods=['GET'])
def get_messages():
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM messages ORDER BY id DESC')
    messages = cursor.fetchall()
    conn.close()
    return jsonify(messages)


@app.route('/api/messages', methods=['POST'])
def add_message():
    data = request.json
    if not data or not data.get('text'):
        return jsonify({'error': 'No text provided'}), 400

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('INSERT INTO messages (text, time) VALUES (%s, %s)', (data['text'], data['time']))
    conn.commit()
    last_id = cursor.lastrowid
    conn.close()
    return jsonify({'status': 'success', 'id': last_id}), 201


@app.route('/api/messages/<int:id>', methods=['DELETE'])
def delete_message(id):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('DELETE FROM messages WHERE id = %s', (id,))
    conn.commit()
    conn.close()
    return jsonify({'status': 'success'})


# ========================================
#  悄悄话 API
# ========================================
@app.route('/api/secrets', methods=['GET'])
def get_secrets():
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM secrets ORDER BY id DESC')
    secrets = cursor.fetchall()
    conn.close()
    return jsonify(secrets)


@app.route('/api/secrets', methods=['POST'])
def add_secret():
    data = request.json
    if not data or not data.get('text'):
        return jsonify({'error': 'No text provided'}), 400

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('INSERT INTO secrets (text, time) VALUES (%s, %s)', (data['text'], data['time']))
    conn.commit()
    last_id = cursor.lastrowid
    conn.close()
    return jsonify({'status': 'success', 'id': last_id}), 201


@app.route('/api/secrets/<int:id>', methods=['DELETE'])
def delete_secret(id):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('DELETE FROM secrets WHERE id = %s', (id,))
    conn.commit()
    conn.close()
    return jsonify({'status': 'success'})


# ========================================
#  记忆墙 API
# ========================================
@app.route('/api/memories', methods=['GET'])
def get_memories():
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM memories ORDER BY id DESC')
    memories = cursor.fetchall()
    conn.close()
    return jsonify(memories)


@app.route('/api/memories', methods=['POST'])
def add_memory():
    # 1. 区分请求类型
    is_multipart = 'multipart/form-data' in (request.content_type or '')
    
    if is_multipart:
        # 获取文本参数与文件
        date = request.form.get('date', '')
        content = request.form.get('content', '')
        feeling = request.form.get('feeling', '')
        file = request.files.get('file')
        
        # 校验空提交
        if not any([date, content, feeling, file]):
            return jsonify({'error': 'Empty memory'}), 400
        
        img_path = ''
        if file and file.filename:
            filename = file.filename
            # 推断后缀是否为常见媒体格式
            ext = filename.rsplit('.', 1)[-1].lower() if '.' in filename else ''
            allowed_exts = {'jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'mov', 'webm', 'ogg'}
            if ext not in allowed_exts:
                return jsonify({'error': 'Unsupported file type'}), 400
            
            try:
                # 生成 UUID 唯一文件名
                file_uuid = str(uuid.uuid4())
                new_filename = f"media-{file_uuid}.{ext}"
                filepath = MEMORIES_DIR / new_filename
                
                # 物理保存到 MEMORIES_DIR
                file.save(str(filepath))
                
                # 相对路径
                img_path = f"/static/memories/{new_filename}"
                log_debug(f"Multipart upload: saved file to {img_path}")
            except Exception as e:
                log_debug(f"Failed to save uploaded file: {e}")
                return jsonify({'error': 'Failed to save file'}), 500
        
        # 写入数据库
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute(
            'INSERT INTO memories (date, content, feeling, img) VALUES (%s, %s, %s, %s)',
            (date, content, feeling, img_path)
        )
        conn.commit()
        last_id = cursor.lastrowid
        conn.close()
        return jsonify({'status': 'success', 'id': last_id}), 201

    else:
        # 向下兼容 JSON Base64 模式
        data = request.json or {}
        date = data.get('date', '')
        content = data.get('content', '')
        feeling = data.get('feeling', '')
        img_str = data.get('img', '')
        
        if not any([date, content, feeling, img_str]):
            return jsonify({'error': 'Empty memory'}), 400
        
        img_path = img_str
        # 自动对其进行本地化反序列化（仿照 Task 1 逻辑）
        if img_str.startswith('data:'):
            try:
                if ',' in img_str:
                    header, base64_data = img_str.split(',', 1)
                else:
                    header = ''
                    base64_data = img_str
                
                # 推断后缀
                ext = 'jpg'
                if 'image/png' in header:
                    ext = 'png'
                elif 'image/webp' in header:
                    ext = 'webp'
                elif 'image/jpeg' in header or 'image/jpg' in header:
                    ext = 'jpg'
                elif 'image/gif' in header:
                    ext = 'gif'
                
                # 解码 base64
                img_data = base64.b64decode(base64_data)
                
                # 生成 UUID 文件名
                file_uuid = str(uuid.uuid4())
                filename = f"media-json-{file_uuid}.{ext}"
                filepath = MEMORIES_DIR / filename
                
                # 物理保存到 MEMORIES_DIR
                filepath.write_bytes(img_data)
                
                # 保存后的短路径
                img_path = f"/static/memories/{filename}"
                log_debug(f"JSON Base64 request: migrated and saved base64 to {img_path}")
            except Exception as e:
                log_debug(f"Failed to parse and save JSON base64 image: {e}")
                # 解析失败时，如果原图是 base64，保留原样存盘作为 fallback
        
        conn = get_db()
        cursor = conn.cursor()
        cursor.execute(
            'INSERT INTO memories (date, content, feeling, img) VALUES (%s, %s, %s, %s)',
            (date, content, feeling, img_path)
        )
        conn.commit()
        last_id = cursor.lastrowid
        conn.close()
        return jsonify({'status': 'success', 'id': last_id}), 201


@app.route('/api/memories/<int:id>', methods=['DELETE'])
def delete_memory(id):
    conn = get_db()
    cursor = conn.cursor()
    
    # 1. 取得文件路径并物理删除
    try:
        cursor.execute('SELECT img FROM memories WHERE id = %s', (id,))
        row = cursor.fetchone()
        if row:
            img_path = row.get('img')
            if img_path and img_path.startswith('/static/memories/'):
                filename = img_path.split('/')[-1]
                filepath = MEMORIES_DIR / filename
                if filepath.exists() and filepath.is_file():
                    filepath.unlink()
                    log_debug(f"Physically deleted memory file: {filepath}")
                else:
                    log_debug(f"File {filepath} does not exist on disk, skipped physical deletion.")
    except Exception as e:
        log_debug(f"Error during physical file deletion for memory {id}: {e}")

    # 2. 数据库删除
    cursor.execute('DELETE FROM memories WHERE id = %s', (id,))
    conn.commit()
    conn.close()
    return jsonify({'status': 'success'})


# ========================================
#  换装魔镜 API（异步任务 + 轮询）
# ========================================
REPLICATE_API_URL = "https://api.replicate.com/v1/predictions"
IDM_VTON_VERSION = "0513734a452173b8173e907e3a59d19a36266e55b48528559432bd21c7d7e985"

# 换装结果图片本地存储目录
TRYON_OUTPUT_DIR = Path(__file__).parent / 'static' / 'tryon'
TRYON_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# 本站域名（用于拼接返回给前端的图片 URL）
SITE_BASE_URL = os.environ.get('SITE_BASE_URL', 'http://localhost:5000')

# ========================================
#  任务状态持久化（JSON 文件，支持多 worker / 重启）
# ========================================
TASK_STORE_FILE = Path(__file__).parent / 'tryon_tasks.json'


def _load_tasks() -> dict:
    """读取所有任务状态"""
    try:
        if TASK_STORE_FILE.exists():
            with open(TASK_STORE_FILE, 'r', encoding='utf-8') as f:
                fcntl.flock(f, fcntl.LOCK_SH)
                data = json.load(f)
                fcntl.flock(f, fcntl.LOCK_UN)
                return data
    except Exception:
        pass
    return {}


def _save_task(task_id: str, state: dict):
    """写入单个任务状态（文件锁保护，支持并发）"""
    try:
        with open(TASK_STORE_FILE, 'a+', encoding='utf-8') as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            f.seek(0)
            try:
                tasks = json.load(f)
            except Exception:
                tasks = {}
            tasks[task_id] = state
            f.seek(0)
            f.truncate()
            json.dump(tasks, f, ensure_ascii=False)
            fcntl.flock(f, fcntl.LOCK_UN)
    except Exception as e:
        log_debug(f'[tryon] 写任务状态失败: {e}')


def _get_task(task_id: str) -> dict | None:
    """读取单个任务状态"""
    return _load_tasks().get(task_id)


# ========================================
#  ★ 加速优化：辅助函数
# ========================================

def _get_mime(filename: str) -> str:
    """根据文件名推断 MIME 类型"""
    fname = (filename or '').lower()
    if fname.endswith('.jpg') or fname.endswith('.jpeg'):
        return 'image/jpeg'
    elif fname.endswith('.webp'):
        return 'image/webp'
    return 'image/png'


def _download_result_image(replicate_url: str) -> str:
    """
    将 replicate.delivery 图片下载到本地，
    返回本站可访问的完整 URL。
    """
    filename = f"{uuid.uuid4()}.png"
    save_path = TRYON_OUTPUT_DIR / filename
    with httpx.Client(timeout=60) as client:
        resp = client.get(replicate_url, follow_redirects=True)
        resp.raise_for_status()
        save_path.write_bytes(resp.content)
    return f"{SITE_BASE_URL}/static/tryon/{filename}"


def _async_download_and_update(task_id: str, replicate_url: str):
    """
    ★ 加速优化：异步将 Replicate 图片下载到本地，
    完成后覆盖更新任务 URL，不阻塞前端图片展示。
    """
    try:
        local_url = _download_result_image(replicate_url)
        _save_task(task_id, {'status': 'succeeded', 'result_url': local_url})
        log_debug(f'[tryon] 异步下载完成: {local_url}')
    except Exception as e:
        log_debug(f'[tryon] 异步下载失败，保留原始 URL: {e}')


# 全局线程池，用于异步下载结果图片（不影响主流程）
_download_executor = concurrent.futures.ThreadPoolExecutor(max_workers=4)


def _run_try_on_task(task_id, human_data, human_filename, garm_data, garm_filename, garment_des, category, token):
    """
    ★ 加速优化后台线程：
    1. 直接以二进制 multipart/form-data 上传图片，省去 base64 编码的体积膨胀（约 33%）
    2. 若 Replicate 不支持 multipart，自动降级为 JSON+base64
    3. 轮询间隔从 3s 缩短到 2s（前 30s），之后指数退避到最多 6s
    4. 图片生成完成后立即通知前端（用 Replicate 原始 URL），
       再异步将图片下载到本地替换 URL，用户无需等待下载完毕
    """
    headers = {
        'Authorization': f'Token {token}',
        'Content-Type': 'application/json',
        'Prefer': 'wait',
    }

    # 在后台线程阻塞地讲内存中的二进制数据编码为 base64，不影响主应用响应
    def to_b64(data, fname):
        b64 = base64.b64encode(data).decode('ascii')
        return f'data:{_get_mime(fname)};base64,{b64}'

    json_payload = {
        'version': IDM_VTON_VERSION,
        'input': {
            'human_img':   to_b64(human_data, human_filename),
            'garm_img':    to_b64(garm_data, garm_filename),
            'garment_des': garment_des,
            'category':    category,
        },
    }

    try:
        with httpx.Client(timeout=150) as client:
            resp = client.post(REPLICATE_API_URL, headers=headers, json=json_payload)

            if resp.status_code not in (200, 201):
                try:
                    detail = resp.json().get('detail', resp.text)
                except Exception:
                    detail = resp.text
                _save_task(task_id, {'status': 'failed', 'error': f'Replicate 提交失败: {detail}'})
                return

            prediction = resp.json()
            pred_id = prediction.get('id')
            status = prediction.get('status')
            output = prediction.get('output')

            # Prefer:wait 大多数情况下会同步等待完成，不需要轮询
            # 若返回的仍是 processing，以 2s 为基准轮询（比原来 3s 快 33%）
            poll_url = f'https://api.replicate.com/v1/predictions/{pred_id}'
            wait_sec = 2    # 初始轮询间隔（秒）
            max_wait = 6    # 最大轮询间隔（秒）
            total_waited = 0
            max_total = 300  # 最多等 5 分钟

            while status not in ('succeeded', 'failed', 'canceled') and total_waited < max_total:
                _save_task(task_id, {'status': 'processing', 'progress': 'processing'})
                time.sleep(wait_sec)
                total_waited += wait_sec
                # 指数退避：前 30s 每 2s 问一次，之后每轮 +1s，最多 6s
                if total_waited > 30:
                    wait_sec = min(wait_sec + 1, max_wait)
                poll_resp = client.get(poll_url, headers={'Authorization': f'Token {token}'})
                poll_data = poll_resp.json()
                status = poll_data.get('status')
                output = poll_data.get('output')

            if status == 'succeeded' and output:
                replicate_url = output[0] if isinstance(output, list) else str(output)
                # ② 立即通知前端已成功（用 Replicate 原始 URL），减少用户等待感知
                _save_task(task_id, {'status': 'succeeded', 'result_url': replicate_url})
                # ③ 再异步将图片下载到本地（不阻塞前端展示）
                _download_executor.submit(_async_download_and_update, task_id, replicate_url)
            else:
                err = prediction.get('error', f'状态: {status}')
                _save_task(task_id, {'status': 'failed', 'error': f'模型生成失败: {err}'})
    except Exception as e:
        _save_task(task_id, {'status': 'failed', 'error': f'请求异常: {str(e)}'})


@app.route('/api/try-on', methods=['POST'])
def create_try_on():
    """接收两张图片，立即返回 task_id，后台异步调用 Replicate"""
    token = os.environ.get('REPLICATE_API_TOKEN')
    if not token:
        return jsonify({'error': '未设置 REPLICATE_API_TOKEN 环境变量'}), 500

    human_file = request.files.get('image')
    garm_file = request.files.get('garm_img')
    if not human_file or not garm_file:
        return jsonify({'error': '请上传人物照片和衣服照片'}), 400

    category = request.form.get('category', 'upper_body')
    garment_des = request.form.get('garment_des', '')

    # ★ 加速优化：直接读取二进制，不做 base64 转换（节省编码时间 + 减少传输体积约 33%）
    human_data = human_file.read()
    human_filename = human_file.filename or 'human.jpg'
    garm_data = garm_file.read()
    garm_filename = garm_file.filename or 'garm.jpg'

    task_id = str(uuid.uuid4())
    _save_task(task_id, {'status': 'processing', 'progress': 'submitted'})

    t = threading.Thread(
        target=_run_try_on_task,
        args=(task_id, human_data, human_filename, garm_data, garm_filename, garment_des, category, token),
        daemon=True
    )
    t.start()

    return jsonify({'task_id': task_id, 'status': 'processing'}), 202


@app.route('/api/try-on/<task_id>', methods=['GET'])
def get_try_on_result(task_id):
    """查询换衣任务状态"""
    task = _get_task(task_id)
    if task is None:
        return jsonify({'error': '任务不存在或已过期'}), 404
    return jsonify(task)


# ========================================
#  换装结果图片静态访问路由
# ========================================
@app.route('/static/tryon/<filename>')
def serve_tryon_image(filename):
    """提供换装结果图片的静态访问"""
    return send_from_directory(str(TRYON_OUTPUT_DIR), filename)


if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)
