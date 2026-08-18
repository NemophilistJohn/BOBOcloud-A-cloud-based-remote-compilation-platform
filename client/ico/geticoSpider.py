import os
import requests

# 业务标识 -> icons目录下file_type_后面的名称（核对仓库真实文件名）
icon_mapping = {
    "java": "java",
    "python": "python",
    "js": "javascript",
    "ts": "typescript",
    "jsx": "react",
    "tsx": "react",
    "go": "go",
    "rust": "rust",
    "cpp": "cpp",
    "c": "c",
    "php": "php",
    "html": "html",
    "css": "css",
    "scss": "scss",
    "sql": "sql",
    "json": "json",
    "yaml": "yaml",
    "docker": "docker",
    "markdown": "markdown",
    "vue": "vue",
    "react": "react",
    "angular": "angular",
    "ruby": "ruby",
    "swift": "swift",
    "kotlin": "kotlin",
    "lua": "lua",
    "bash": "bash",
    "xml": "xml",
    "git": "git",
    "csv": "csv"
}

# 保存文件夹
save_dir = "vscode_filetype_icons"
os.makedirs(save_dir, exist_ok=True)

# github raw基础地址，对应master分支icons目录
raw_base = "https://raw.githubusercontent.com/vscode-icons/vscode-icons/master/icons"

def download_icon(biz_name, file_tag):
    svg_filename = f"file_type_{file_tag}.svg"
    # 拼接可直接下载的raw链接
    download_url = f"{raw_base}/{svg_filename}"
    save_path = os.path.join(save_dir, svg_filename)

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
    }
    try:
        resp = requests.get(download_url, headers=headers, timeout=15)
        resp.raise_for_status()
        with open(save_path, "wb") as f:
            f.write(resp.content)
        print(f"✅ {biz_name:10s} | {svg_filename} 下载成功")
    except Exception as e:
        print(f"❌ {biz_name:10s} | {svg_filename} 失败: {str(e)}")

if __name__ == "__main__":
    print("=== 开始批量下载 vscode-icons file_type 图标 ===")
    for biz_key, tag in icon_mapping.items():
        download_icon(biz_key, tag)
    print(f"\n下载完成，图标全部保存在 ./{save_dir}/")