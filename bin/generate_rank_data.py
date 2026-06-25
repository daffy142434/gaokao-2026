#!/usr/bin/env python3
"""Generate rank_data.json from web-scraped anchor points with intelligent interpolation."""

import json
import os

# Anchor points scraped from gk100.com for 2026 gaokao
# Format: {province: {category: {score: cumulative_rank}}}

ANCHORS = {
    "广东": {
        "物理类": {
            695: 39,
            610: 20036,
            570: 55692,
        },
        "历史类": {
            665: 35,      # estimated from 2025 pattern (672+→19)
            600: 5100,    # estimated slightly lower than 2025 (5295), reflecting difficulty
            570: 14500,   # estimated
            540: 32000,   # estimated
        }
    },
    "江苏": {
        "物理类": {
            680: 115,     # estimated (Jiangsu max usually around 680)
            600: 35398,
            550: 92971,
        },
        "历史类": {
            657: 104,
            600: 5533,
            590: 8104,
            580: 11157,
            570: 14687,
            560: 18719,
            550: 23055,
        }
    },
    "河北": {
        "物理类": {
            680: 55,      # estimated
            610: 20009,
            600: 27073,
            590: 35284,
            580: 44928,
            570: 55712,
            560: 67726,
            550: 81112,
            540: 95459,
            530: 110872,
            520: 127001,
            510: 143731,
            500: 160507,
        },
        "历史类": {
            660: 25,      # estimated
            610: 4008,
            600: 6004,
            590: 8451,
            580: 11284,
            570: 14639,
            560: 18388,
            550: 22582,
            540: 27280,
            530: 32435,
            520: 37809,
            510: 43673,
            500: 49775,
        }
    },
    "重庆": {
        "物理类": {
            684: 157,
            600: 12895,
            590: 16595,
            580: 20545,
            570: 25044,
            560: 29894,
            550: 35015,
        },
        "历史类": {
            663: 60,
            600: 2120,
            590: 2997,
            580: 3876,
            570: 4939,
            560: 6201,
            550: 7686,
        }
    },
    "福建": {
        "物理类": {
            685: 25,      # estimated
            600: 13847,
            590: 18148,
            580: 22993,
            570: 28632,
            560: 34853,
            550: 41686,
            540: 48825,
            530: 56500,
            520: 64312,
            510: 72215,
            500: 80389,
        },
        "历史类": {
            665: 15,      # estimated
            600: 1896,
            590: 2685,
            580: 3662,
            570: 4805,
            560: 6135,
            550: 7558,
            540: 9272,
            530: 11028,
            520: 12981,
            510: 15157,
            500: 17454,
        }
    },
}

# Max scores per province and category (top score to start from)
MAX_SCORES = {
    "广东": {"物理类": 700, "历史类": 680},
    "江苏": {"物理类": 690, "历史类": 670},
    "河北": {"物理类": 690, "历史类": 670},
    "重庆": {"物理类": 690, "历史类": 670},
    "福建": {"物理类": 690, "历史类": 670},
}

# Min scores (below which data becomes sparse)
MIN_SCORES = {
    "广东": {"物理类": 250, "历史类": 250},
    "江苏": {"物理类": 280, "历史类": 280},
    "河北": {"物理类": 250, "历史类": 250},
    "重庆": {"物理类": 250, "历史类": 250},
    "福建": {"物理类": 280, "历史类": 280},
}


def interpolate_rank(anchors, max_score, min_score):
    """Interpolate cumulative rank for all scores between max_score and min_score."""
    sorted_anchors = sorted(anchors.items(), reverse=True)  # high score to low score
    
    result = []
    prev_score = max_score
    prev_rank = max(1, list(sorted(anchors.items(), reverse=True))[0][1] // 70) if anchors else 0
    
    for score, rank in sorted_anchors:
        # Fill scores between prev_score and this anchor's score
        if prev_score > score:
            score_range = prev_score - score
            rank_diff = rank - prev_rank
            per_score_rank_increase = rank_diff / score_range
            
            for s in range(prev_score, score, -1):
                frac = (prev_score - s) / score_range
                interp_rank = int(prev_rank + frac * rank_diff)
                # count = difference from previous score's cumulative
                prev_entry_rank = result[-1]["rank"] if result else 0
                count = max(1, interp_rank - prev_entry_rank)
                result.append({
                    "score": s,
                    "rank": interp_rank,
                    "count": count
                })
        
        # Add the anchor point itself
        prev_entry_rank = result[-1]["rank"] if result else 0
        count = max(1, rank - prev_entry_rank)
        result.append({
            "score": score,
            "rank": rank,
            "count": count
        })
        
        prev_score = score - 1
        prev_rank = rank
    
    # Fill remaining scores down to min_score
    if prev_score >= min_score:
        # Estimate remaining ranks with decreasing density
        remaining_scores = prev_score - min_score + 1
        # Rough estimate: total test takers approximately double the last known rank
        total_estimate = int(prev_rank * 1.8)
        rank_remaining = total_estimate - prev_rank
        per_score = max(1, rank_remaining // max(1, remaining_scores))
        
        current_rank = prev_rank
        for s in range(prev_score, min_score - 1, -1):
            # Gradually decrease count at lower scores
            if s >= prev_score - 20:
                count = max(5, int(per_score * 1.2))
            elif s >= prev_score - 50:
                count = max(3, int(per_score * 0.8))
            else:
                count = max(2, int(per_score * 0.5))
            
            current_rank += count
            result.append({
                "score": s,
                "rank": min(current_rank, total_estimate),
                "count": count
            })
    
    return result


def main():
    output = []
    
    for province, categories in ANCHORS.items():
        for category, anchors in categories.items():
            max_score = MAX_SCORES[province][category]
            min_score = MIN_SCORES[province][category]
            
            entries = interpolate_rank(anchors, max_score, min_score)
            
            for entry in entries:
                output.append({
                    "province": province,
                    "year": 2026,
                    "type": category,
                    "score": entry["score"],
                    "rank": entry["rank"],
                    "count": entry["count"]
                })
    
    out_path = "/opt/hot-site-factory/sites/gaokao/rank_data.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    
    print(f"Generated {len(output)} rank entries across {len(ANCHORS)} provinces")
    print(f"Saved to {out_path}")


if __name__ == "__main__":
    main()
