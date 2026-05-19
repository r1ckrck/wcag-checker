---
title: "Clarifying Questions for Samarthyam"
author: "Arnesh Mandal"
version: "1.0"
date: "2026-05-19"
include-before: |
  \begin{lstlisting}[style=coverasciiart]
          ::::::::::::::::   ################
          ::::::::::::::::   ################
          ::::::::::::::::   ################
          ::::::::::::::::   ################
          ::::::::::::::::   ################

          CLARIFYING  QUESTIONS

          WCAG Accessibility Workshop
          Contrast / Typography / Methodology
  \end{lstlisting}
---

# Contrast Math Exceptions

**Does the contrast math have documented exceptions for cases where the formula and the eye disagree?**

WCAG contrast is a luminance-ratio calculation — a single number standing in for something optical.
A number can't fully capture how a colour pair actually reads, and perceived contrast also shifts with the typeface: a humanist face, a font with optical sizing, and a thin geometric face at the *same* measured ratio do not read the same.

A common real-world example is **white text on a saturated orange or yellow CTA**: it frequently fails the 4.5:1 calculation yet appears readable to most users, which is why it stays widely used in practice.
We came across an independent investigation by a practitioner that reached a similar conclusion — carefully done, though not formally peer-reviewed, so we're treating it as suggestive rather than authoritative.
We'd value your guidance on how to handle this in audits and design systems:

- When a colour pair fails the measured ratio but appears readable, is there an **accepted exception process** — an evidence bar (sample size, user profiles), a sign-off, and a way to record the exception so it stays auditable?
- Do WCAG, GIGW, or IS 17802 define such an exception anywhere, or is it left to professional judgement?
- When the measured ratio and user testing disagree, which one is binding for certification?
- Do you ever use a **perceptual model (e.g., APCA / WCAG 3 draft)** as a cross-check, or is the WCAG 2.x luminance ratio the sole authority?

# Font Weight and Stroke Thickness

**Why is font weight / stroke thickness absent from the contrast criteria?**

Today the text-contrast criterion has only two buckets — **normal text (4.5:1)** and **large text (3:1)**.
Weight is only partially acknowledged inside the "large text" definition (bold lowers the size threshold).
But a **thin or hairline weight stays just as hard to read no matter how large it gets** if the colour relationship is weak.
Stroke thickness drives legibility as much as point size, yet it is not an independent input to the ratio requirement.

- Should a thin/light weight be held to a *stricter* ratio than the size-based bucket implies?
- In your audits, do you ever down-rate a pass because the weight makes it perceptually fail, or is the verdict purely size + measured ratio?
- Is there any guidance (WCAG, GIGW, IS 17802, or Samarthyam practice) that treats weight as a contrast factor rather than only a size modifier?

# Tooling Versus Designer Judgement

**How do automated tooling and designer judgement fit together for sign-off?**

We heard two emphases across the sessions that we'd like to reconcile for our own process:

| Emphasis | Heard As |
|------|----------------------------------------------------|
| Tool-led | "Check contrast with a tool, not your eyes — always test with an automated tool." |
| Designer-led | "I depend on the designer, more than automated or manual testing alone." |
: Two emphases heard across the sessions

Both make sense in context.
For a team building a checker: when the tool reports a fail but a designer or user study suggests it's acceptable, **which takes precedence**, and is there a defined override / exception path?
