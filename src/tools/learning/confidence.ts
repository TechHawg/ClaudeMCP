/**
 * Confidence Scorer — scores proposed bets 1-10 based on confirming signals.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface ConfidenceInput {
  sport: string;
  game: string;
  side: string;
  bet_type: string;
  odds: number;
  edge_pct?: number;
  sharp_pct?: number;
  line_movement_favorable?: boolean;
  reverse_line_movement?: boolean;
  steam_move?: boolean;
  situational_angles_matched?: number;
  weather_impact?: "none" | "favorable" | "unfavorable";
  injury_advantage?: boolean;
  data_completeness?: number; // 0-100
  historical_roi_for_type?: number;
}

export interface ConfidenceResult {
  score: number; // 1-10
  grade: string; // A+ through F
  breakdown: ConfidenceBreakdownItem[];
  recommendation: string;
}

export interface ConfidenceBreakdownItem {
  signal: string;
  value: string;
  contribution: number; // points added or subtracted
  status: "positive" | "negative" | "neutral" | "missing";
}

// ── Implementation ───────────────────────────────────────────────────────────

export function getConfidenceScore(input: ConfidenceInput): ConfidenceResult {
  const breakdown: ConfidenceBreakdownItem[] = [];
  let score = 5; // Start at neutral

  // 1. Edge percentage
  if (input.edge_pct != null) {
    if (input.edge_pct >= 5) {
      score += 2;
      breakdown.push({
        signal: "Statistical Edge",
        value: `${input.edge_pct.toFixed(1)}%`,
        contribution: 2,
        status: "positive",
      });
    } else if (input.edge_pct >= 2) {
      score += 1;
      breakdown.push({
        signal: "Statistical Edge",
        value: `${input.edge_pct.toFixed(1)}%`,
        contribution: 1,
        status: "positive",
      });
    } else if (input.edge_pct < 0) {
      score -= 1;
      breakdown.push({
        signal: "Statistical Edge",
        value: `${input.edge_pct.toFixed(1)}%`,
        contribution: -1,
        status: "negative",
      });
    }
  } else {
    score -= 0.5;
    breakdown.push({
      signal: "Statistical Edge",
      value: "Not calculated",
      contribution: -0.5,
      status: "missing",
    });
  }

  // 2. Sharp money alignment
  if (input.sharp_pct != null) {
    if (input.sharp_pct >= 60) {
      score += 1.5;
      breakdown.push({
        signal: "Sharp Money",
        value: `${input.sharp_pct}% on your side`,
        contribution: 1.5,
        status: "positive",
      });
    } else if (input.sharp_pct <= 40) {
      score -= 1;
      breakdown.push({
        signal: "Sharp Money",
        value: `${input.sharp_pct}% (against you)`,
        contribution: -1,
        status: "negative",
      });
    }
  } else {
    breakdown.push({
      signal: "Sharp Money",
      value: "No data",
      contribution: -0.25,
      status: "missing",
    });
    score -= 0.25;
  }

  // 3. Line movement
  if (input.reverse_line_movement) {
    score += 1.5;
    breakdown.push({
      signal: "Reverse Line Movement",
      value: "Detected — strong sharp signal",
      contribution: 1.5,
      status: "positive",
    });
  } else if (input.line_movement_favorable) {
    score += 0.5;
    breakdown.push({
      signal: "Line Movement",
      value: "Favorable",
      contribution: 0.5,
      status: "positive",
    });
  }

  // 4. Steam move
  if (input.steam_move) {
    score += 1;
    breakdown.push({
      signal: "Steam Move",
      value: "Active — multiple books moved simultaneously",
      contribution: 1,
      status: "positive",
    });
  }

  // 5. Situational angles
  if (input.situational_angles_matched != null) {
    if (input.situational_angles_matched >= 3) {
      score += 1;
      breakdown.push({
        signal: "Situational Angles",
        value: `${input.situational_angles_matched} matching`,
        contribution: 1,
        status: "positive",
      });
    } else if (input.situational_angles_matched >= 1) {
      score += 0.5;
      breakdown.push({
        signal: "Situational Angles",
        value: `${input.situational_angles_matched} matching`,
        contribution: 0.5,
        status: "positive",
      });
    }
  }

  // 6. Weather
  if (input.weather_impact === "favorable") {
    score += 0.5;
    breakdown.push({
      signal: "Weather",
      value: "Favorable conditions",
      contribution: 0.5,
      status: "positive",
    });
  } else if (input.weather_impact === "unfavorable") {
    score -= 1;
    breakdown.push({
      signal: "Weather",
      value: "Unfavorable — working against your bet",
      contribution: -1,
      status: "negative",
    });
  }

  // 7. Injury advantage
  if (input.injury_advantage) {
    score += 0.5;
    breakdown.push({
      signal: "Injury Edge",
      value: "Injury advantage detected",
      contribution: 0.5,
      status: "positive",
    });
  }

  // 8. Data completeness penalty
  if (input.data_completeness != null) {
    if (input.data_completeness < 50) {
      score -= 1;
      breakdown.push({
        signal: "Data Completeness",
        value: `${input.data_completeness}% — significant data gaps`,
        contribution: -1,
        status: "negative",
      });
    } else if (input.data_completeness < 75) {
      score -= 0.5;
      breakdown.push({
        signal: "Data Completeness",
        value: `${input.data_completeness}%`,
        contribution: -0.5,
        status: "negative",
      });
    }
  }

  // 9. Historical performance
  if (input.historical_roi_for_type != null) {
    if (input.historical_roi_for_type > 5) {
      score += 0.5;
      breakdown.push({
        signal: "Historical ROI",
        value: `+${input.historical_roi_for_type.toFixed(1)}% in this category`,
        contribution: 0.5,
        status: "positive",
      });
    } else if (input.historical_roi_for_type < -5) {
      score -= 0.5;
      breakdown.push({
        signal: "Historical ROI",
        value: `${input.historical_roi_for_type.toFixed(1)}% — losing category`,
        contribution: -0.5,
        status: "negative",
      });
    }
  }

  // Clamp to 1-10
  score = Math.max(1, Math.min(10, Math.round(score * 10) / 10));

  const grade = scoreToGrade(score);
  const recommendation = generateRecommendation(score, breakdown);

  return { score, grade, breakdown, recommendation };
}

function scoreToGrade(score: number): string {
  if (score >= 9) return "A+";
  if (score >= 8) return "A";
  if (score >= 7) return "B+";
  if (score >= 6) return "B";
  if (score >= 5) return "C";
  if (score >= 4) return "D";
  return "F";
}

function generateRecommendation(
  score: number,
  breakdown: ConfidenceBreakdownItem[]
): string {
  const positives = breakdown.filter((b) => b.status === "positive").length;
  const negatives = breakdown.filter((b) => b.status === "negative").length;
  const missing = breakdown.filter((b) => b.status === "missing").length;

  if (score >= 8) {
    return `Strong play (${positives} confirming signals). Consider full Kelly fraction.`;
  }
  if (score >= 6) {
    return `Decent play (${positives} positives, ${negatives} negatives). Use quarter Kelly or smaller.`;
  }
  if (score >= 4) {
    if (missing > 2) {
      return `Insufficient data to form conviction. Gather more signals before betting.`;
    }
    return `Marginal play — the signals are mixed. Small stake only if you have a strong read.`;
  }
  return `Avoid this bet. ${negatives} negative signals outweigh the ${positives} positive ones.`;
}
