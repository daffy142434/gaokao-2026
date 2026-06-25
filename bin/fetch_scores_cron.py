#!/usr/bin/env python3
"""
高考分数线自动抓取脚本
每天凌晨3点cron执行，从阳光高考网抓取最新分数线。

Cron: 0 3 * * * cd /opt/hot-site-factory/sites/gaokao && python3 bin/fetch_scores_cron.py
"""

import json
import re
import os
import sys
from datetime import datetime
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

# Configuration
CHSI_URL = "https://gaokao.chsi.com.cn/z/gkbmfslq/pcx.jsp"
SCORES_FILE = "/opt/hot-site-factory/sites/gaokao/scores.json"
TARGET_YEAR = 2026
TOTAL_PROVINCES = 31  # All mainland provinces

# Known province names as they appear in the HTML
ALL_PROVINCES = [
    "北京", "天津", "河北", "山西", "内蒙古",
    "辽宁", "吉林", "黑龙江",
    "上海", "江苏", "浙江", "安徽", "福建", "江西", "山东",
    "河南", "湖北", "湖南", "广东", "广西", "海南",
    "重庆", "四川", "贵州", "云南", "西藏",
    "陕西", "甘肃", "青海", "宁夏", "新疆",
]

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0.0.0 Safari/537.36"
)


def log(msg: str):
    """Print log message with timestamp for cron output."""
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def fetch_page(url: str) -> str:
    """Fetch the CHSI gaokao score page."""
    req = Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "zh-CN,zh;q=0.9",
    })
    try:
        with urlopen(req, timeout=30) as resp:
            raw = resp.read()
            # Detect encoding
            charset = resp.headers.get_content_charset() or "utf-8"
            return raw.decode(charset, errors="replace")
    except HTTPError as e:
        log(f"HTTP Error: {e.code} {e.reason}")
        raise
    except URLError as e:
        log(f"URL Error: {e.reason}")
        raise


def parse_scores(html: str, year: int) -> list[dict]:
    """
    Parse the CHSI HTML table to extract province scores.
    
    The page structure:
    - Each <tr> in <tbody> represents a province
    - First <td class="td-left"> is province name
    - Following <td>s contain score data like:
      "特控线：542<br>普通本科：485<br>普通专科：200"
      Or for some provinces (no 文理 split): "特控线：504<br>普通本科：403"
    """
    results = []
    
    # Find the tbody containing province data
    tbody_match = re.search(r'<tbody>(.*?)</tbody>', html, re.DOTALL)
    if not tbody_match:
        log("Warning: Could not find tbody in HTML")
        return results
    
    tbody = tbody_match.group(1)
    
    # Split into rows (each province)
    rows = re.findall(r'<tr>(.*?)</tr>', tbody, re.DOTALL)
    
    for row in rows:
        # Extract province name
        province_match = re.search(r'<td[^>]*class="td-left"[^>]*>\s*(.+?)\s*</td>', row)
        if not province_match:
            continue
        
        province = province_match.group(1).strip()
        
        # Skip header rows or non-province entries
        if province not in ALL_PROVINCES:
            # Handle "西藏" which has rowspan and may appear in sub-rows
            if "西藏" not in province:
                continue
        
        # Find all td cells with score data (those with <br>)
        # The cells are: 第1个td=省份, 第2个=总分, 第3-5个=文科/历史(3列),
        # 第6-8个=理科/物理(3列), then 对比链接
        cells = re.findall(r'<td[^>]*>(.*?)</td>', row, re.DOTALL)
        
        if len(cells) < 3:
            continue
        
        # Determine if this province has split 文/理 or combined data
        # Combined: colspan="6" across both 文 and 理 columns
        # Split: 3 td for 文, 3 td for 理
        
        all_cell_text = " ".join(cells)
        
        # Detect combined vs split
        has_colspan_6 = 'colspan="6"' in row or 'colspan=\\"6\\"' in row
        
        # Parse scores from cells
        scores_data = []
        
        # Cell 0 = province, Cell 1 = total score, cells 2+ = score data
        # For combined provinces: the 6 cells (文3+理3) are merged into one td with colspan=6
        # For split provinces: cells[1] through cells[6] have 3 for 文 and 3 for 理
        
        if has_colspan_6:
            # Combined: Shanghai, Tianjin, etc.
            # Find the combined score cell
            for cell in cells:
                if "特控" in cell or "本科" in cell or "专科" in cell or "批" in cell:
                    parsed = _parse_score_cell(cell, province, "综合", year)
                    scores_data.extend(parsed)
                    break
        else:
            # Split into 文/理
            # Find cells that contain batch score data (with batch labels like 特控/本科/专科)
            # Exclude cells that are just numbers (like "750" total score)
            score_cells = []
            for cell in cells:
                stripped = re.sub(r'<[^>]+>', '', cell).strip()  # Strip HTML tags
                if stripped and re.search(r'(?:特控|本科|专科|批)', stripped) and re.search(r'\d{3}', stripped):
                    score_cells.append(stripped)
            
            if len(score_cells) >= 2:
                # Check if this is 新疆-style (individual td per batch, no <br>)
                # 新疆 uses separate cells for each batch, 3 for 文 and 3 for 理
                has_separate_cells = all('<br' not in cell for cell in cells if re.search(r'\d{3}', re.sub(r'<[^>]+>', '', cell)))
                
                if has_separate_cells and len(score_cells) >= 6:
                    # 新疆-style: first half = 文/历史, second half = 理/物理
                    mid = len(score_cells) // 2
                    for cat, batch_cells in [("历史类", score_cells[:mid]), ("物理类", score_cells[mid:])]:
                        for sc in batch_cells:
                            parsed = _parse_score_cell(sc, province, cat, year)
                            scores_data.extend(parsed)
                else:
                    # Standard split: first score cell = 文/历史, second = 理/物理
                    parsed_wen = _parse_score_cell(score_cells[0], province, "历史类", year)
                    scores_data.extend(parsed_wen)
                    parsed_li = _parse_score_cell(score_cells[1], province, "物理类", year)
                    scores_data.extend(parsed_li)
            elif len(score_cells) == 1:
                # Could be combined (e.g., 上海/天津) or mixed (e.g., 新疆)
                # Check if this is actually a combined province
                if has_colspan_6:
                    parsed = _parse_score_cell(score_cells[0], province, "综合", year)
                    scores_data.extend(parsed)
                else:
                    # Try mixed parsing
                    parsed = _parse_mixed_cell(score_cells[0], province, year)
                    if not parsed:
                        parsed = _parse_score_cell(score_cells[0], province, "综合", year)
                    scores_data.extend(parsed)
        
        results.extend(scores_data)
    
    return results


def _parse_score_cell(cell_text: str, province: str, category: str, year: int) -> list[dict]:
    """Parse a single score cell like '特控线：542<br>普通本科：485<br>普通专科：200'"""
    results = []
    
    # Mapping of batch names
    batch_map = {
        "特控": "特控线",
        "本科一批": "本科一批",
        "一本": "本科一批",
        "本科二批": "本科二批",
        "二本": "本科二批",
        "普通本科": "本科线",
        "本科": "本科线",
        "普通专科": "专科线",
        "高职专科": "专科线",
        "专科": "专科线",
        "高职专科批": "专科线",
        "高职": "专科线",
    }
    
    # Extract patterns like "特控线：542" or "普通本科：485"
    patterns = re.findall(
        r'((?:特控线|本科一批|本科二批|普通本科|普通专科|高职专科批|高职专科|一本|二本|本科|专科|高职)[：:]\s*\d{3})',
        cell_text,
        re.IGNORECASE
    )
    
    for pat in patterns:
        # Split label and score
        match = re.match(r'(.+?)[：:]\s*(\d{3})', pat)
        if match:
            label = match.group(1).strip()
            score = int(match.group(2))
            
            # Normalize batch name
            batch = None
            for key, value in batch_map.items():
                if key in label:
                    batch = value
                    break
            
            if batch and score > 0:
                results.append({
                    "province": province,
                    "year": year,
                    "type": category,
                    "batch": batch,
                    "score": score,
                    "source": CHSI_URL
                })
    
    return results


def _parse_mixed_cell(cell_text: str, province: str, year: int) -> list[dict]:
    """Parse mixed cell where 文 and 理 are in the same text block.
    Example: '本科一批：451<br>本科二批：315<br>...'
    with separate 文/理 sections."""
    results = []
    
    # Try to find explicit markers for 文/理 split
    # Some provinces use 文科/理科 markers
    # Others use position-based (first set = 文, second = 理)
    
    batch_entries = re.findall(
        r'((?:本科一批|本科二批|高职专科批|特控线|普通本科|普通专科)\s*[：:]\s*\d{3})',
        cell_text
    )
    
    if len(batch_entries) >= 6:
        # Split in half: first 3 for 文, last 3 for 理
        mid = len(batch_entries) // 2
        for cat, entries in [("历史类", batch_entries[:mid]), ("物理类", batch_entries[mid:])]:
            for entry in entries:
                match = re.match(r'(.+?)[：:]\s*(\d{3})', entry)
                if match:
                    batch_name = _normalize_batch(match.group(1).strip())
                    score = int(match.group(2))
                    if batch_name and score > 0:
                        results.append({
                            "province": province,
                            "year": year,
                            "type": cat,
                            "batch": batch_name,
                            "score": score,
                            "source": CHSI_URL
                        })
    
    return results


def _normalize_batch(label: str) -> str:
    """Normalize batch label to standard names."""
    mapping = {
        "特控线": "特控线",
        "本科一批": "本科一批",
        "本科二批": "本科二批",
        "普通本科": "本科线",
        "普通专科": "专科线",
        "高职专科批": "专科线",
        "高职专科": "专科线",
    }
    for key, value in mapping.items():
        if key in label:
            return value
    return None


def load_existing_scores(path: str) -> list[dict]:
    """Load existing scores from JSON file."""
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            log(f"Warning: Could not load existing scores: {e}")
    return []


def save_scores(scores: list[dict], path: str):
    """Save scores to JSON file."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(scores, f, ensure_ascii=False, indent=2)
    log(f"Saved {len(scores)} score entries to {path}")


def merge_scores(existing: list[dict], new_scores: list[dict]) -> list[dict]:
    """Merge new scores into existing data, updating duplicates."""
    # Build a key-based index: (province, year, type, batch)
    index = {}
    for i, entry in enumerate(existing):
        key = (entry["province"], entry["year"], entry["type"], entry["batch"])
        index[key] = i
    
    added = 0
    updated = 0
    
    for new_entry in new_scores:
        key = (new_entry["province"], new_entry["year"], new_entry["type"], new_entry["batch"])
        if key in index:
            # Update existing
            existing[index[key]] = new_entry
            updated += 1
        else:
            # Append new
            existing.append(new_entry)
            index[key] = len(existing) - 1
            added += 1
    
    if added > 0:
        log(f"Added {added} new score entries")
    if updated > 0:
        log(f"Updated {updated} existing score entries")
    
    return existing


def check_completeness(scores: list[dict], year: int) -> dict:
    """Check how many provinces have data for the given year."""
    year_scores = [s for s in scores if s["year"] == year]
    provinces_with_data = set(s["province"] for s in year_scores)
    
    total = len(ALL_PROVINCES)
    covered = len(provinces_with_data)
    missing = [p for p in ALL_PROVINCES if p not in provinces_with_data]
    
    return {
        "total": total,
        "covered": covered,
        "missing": missing,
        "is_done": covered >= total,
    }


def main():
    log("=" * 60)
    log("高考分数线自动抓取脚本启动")
    log(f"目标URL: {CHSI_URL}")
    log(f"数据文件: {SCORES_FILE}")
    log("=" * 60)
    
    # Step 1: Fetch the page
    log("正在获取阳光高考网分数线页面...")
    try:
        html = fetch_page(CHSI_URL)
        log(f"页面获取成功，大小: {len(html)} bytes")
    except Exception as e:
        log(f"错误: 无法获取页面 - {e}")
        sys.exit(1)
    
    # Step 2: Parse scores
    log("正在解析分数线数据...")
    new_scores = parse_scores(html, TARGET_YEAR)
    log(f"解析到 {len(new_scores)} 条分数线记录")
    
    if not new_scores:
        log("警告: 未解析到任何分数线数据，检查页面结构是否变化")
        log("尝试输出页面片段用于调试...")
        # Output a snippet for debugging
        debug_snippet = html[html.find("<tbody>"):html.find("</tbody>")+8] if "<tbody>" in html else "N/A"
        log(f"tbody内容片段: {debug_snippet[:500]}...")
        sys.exit(2)
    
    # Step 3: Load existing and merge
    existing = load_existing_scores(SCORES_FILE)
    log(f"已加载 {len(existing)} 条现有记录")
    
    merged = merge_scores(existing, new_scores)
    
    # Step 4: Save
    save_scores(merged, SCORES_FILE)
    
    # Step 5: Check completeness
    status = check_completeness(merged, TARGET_YEAR)
    log(f"省份覆盖情况: {status['covered']}/{status['total']}")
    
    if status["missing"]:
        log(f"缺失省份({len(status['missing'])}): {', '.join(status['missing'])}")
    
    if status["is_done"]:
        log("=" * 60)
        log("✓ DONE - 所有省份分数线数据已完整采集!")
        log("=" * 60)
        print("DONE", flush=True)
    else:
        log("=" * 60)
        log(f"尚未完成，还缺 {len(status['missing'])} 个省份的数据")
        log("=" * 60)
    
    # Step 6: Print summary
    log("\n各批次分数线摘要:")
    for s in new_scores:
        log(f"  {s['province']} | {s['type']} | {s['batch']}: {s['score']}分")


if __name__ == "__main__":
    main()
