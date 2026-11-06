
const mongoose = require("mongoose");
const User = require("../../models/User");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

// =====================================
// GENERATE MEMBER / REFERRAL CODE
// =====================================

function generateCode(prefix) {
  return prefix + crypto.randomBytes(5).toString("hex").toUpperCase();
}

// =====================================
// CUSTOM REGISTRATION ERROR
// =====================================

function registrationError(message, code) {
  const error = new Error(message);
  error.registrationCode = code;
  return error;
}

// =====================================
// FIND AUTOMATIC BINARY PLACEMENT
// BREADTH-FIRST SEARCH
// =====================================

async function findPlacement(sponsor, selectedSide) {
  const firstChildId =
    selectedSide === "left"
      ? sponsor.leftChildId
      : sponsor.rightChildId;

  const firstSlot =
    selectedSide === "left"
      ? "leftChildId"
      : "rightChildId";

  // Check sponsor's selected position first

  if (!firstChildId) {
    return {
      parentId: sponsor._id,
      position: selectedSide,
      slotField: firstSlot
    };
  }

  // Search only inside the selected branch

  const queue = [firstChildId];
  const visited = new Set();

  let queueIndex = 0;

  while (queueIndex < queue.length) {
    const currentId = queue[queueIndex++];
    const currentIdString = currentId.toString();

    if (visited.has(currentIdString)) {
      throw new Error(
        "Invalid binary tree: circular placement reference."
      );
    }

    visited.add(currentIdString);

    const parent = await User.findById(currentId)
      .select("leftChildId rightChildId")
      .lean();

    if (!parent) {
      throw new Error(
        "Invalid binary tree: placement member not found."
      );
    }

    // Check LEFT first

    if (!parent.leftChildId) {
      return {
        parentId: parent._id,
        position: "left",
        slotField: "leftChildId"
      };
    }

    // Check RIGHT second

    if (!parent.rightChildId) {
      return {
        parentId: parent._id,
        position: "right",
        slotField: "rightChildId"
      };
    }

    // Continue BFS

    queue.push(parent.leftChildId);
    queue.push(parent.rightChildId);
  }

  throw new Error(
    "No available binary placement position found."
  );
}

// =====================================
// RESERVE BINARY PLACEMENT
// STANDALONE MONGODB COMPATIBLE
// =====================================

async function reservePlacement(
  sponsorId,
  selectedSide,
  newUserId
) {
  const maxAttempts = 20;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {

    // Refresh sponsor so that we don't use stale child pointers

    const sponsor = await User.findOne({
      _id: sponsorId,
      role: "member",
      status: {
        $in: ["active", "pending_activation"]
      }
    }).select("leftChildId rightChildId");

    if (!sponsor) {
      throw registrationError(
        "Sponsor is no longer eligible to refer members.",
        "INVALID_REFERRAL"
      );
    }

    const placement = await findPlacement(
      sponsor,
      selectedSide
    );

    // Atomic reservation: only one registration can claim this slot

    const updateResult = await User.updateOne(
      {
        _id: placement.parentId,
        [placement.slotField]: null
      },
      {
        $set: {
          [placement.slotField]: newUserId
        }
      }
    );

    if (updateResult.modifiedCount === 1) {
      return {
        ...placement,
        sponsorId: sponsor._id
      };
    }

    // Another registration may have reserved this position.
    // Retry with a fresh tree search.
  }

  throw registrationError(
    "Team placement is busy. Please try registering again.",
    "PLACEMENT_CONFLICT"
  );
}

// =====================================
// ROLLBACK BINARY PLACEMENT
// IF MEMBER CREATION FAILS
// =====================================

async function releasePlacement(placement, newUserId) {
  const result = await User.updateOne(
    {
      _id: placement.parentId,
      [placement.slotField]: newUserId
    },
    {
      $set: {
        [placement.slotField]: null
      }
    }
  );

  if (result.modifiedCount !== 1) {
    console.error(
      "CRITICAL: Could not release binary placement reservation.",
      {
        parentId: placement.parentId,
        slotField: placement.slotField,
        newUserId
      }
    );

    throw new Error(
      "Registration failed and binary placement requires manual recovery."
    );
  }
}

// =====================================
// REGISTER
// =====================================

exports.register = async (req, res, next) => {

  try {

    const {
      name,
      email,
      mobile,
      password,
      referralCode,
      placementSide
    } = req.body;

    // ---------------------------------
    // NORMALIZE USER DETAILS
    // ---------------------------------

    const normalizedName = String(name || "").trim();

    const normalizedEmail = String(email || "")
      .trim()
      .toLowerCase();

    const normalizedMobile = String(mobile || "").trim();

    const normalizedPassword = String(password || "");

    const normalizedReferralCode = String(referralCode || "")
      .trim()
      .toUpperCase();

    const normalizedPlacementSide = String(placementSide || "")
      .trim()
      .toLowerCase();

    // ---------------------------------
    // REQUIRED FIELD VALIDATION
    // ---------------------------------

    if (
      !normalizedName ||
      !normalizedEmail ||
      !normalizedMobile ||
      !normalizedPassword
    ) {
      return res.status(400).render("auth/register", {
        title: "Register",
        error: "All required fields must be filled."
      });
    }

    // ---------------------------------
    // PASSWORD VALIDATION
    // ---------------------------------

    if (normalizedPassword.length < 8) {
      return res.status(400).render("auth/register", {
        title: "Register",
        error: "Password must contain at least 8 characters."
      });
    }

    // ---------------------------------
    // REFERRAL POSITION VALIDATION
    // ---------------------------------

    if (normalizedReferralCode) {

      if (!["left", "right"].includes(normalizedPlacementSide)) {
        return res.status(400).render("auth/register", {
          title: "Register",
          error: "Please select Left or Right team position."
        });
      }

    } else if (normalizedPlacementSide) {

      return res.status(400).render("auth/register", {
        title: "Register",
        error: "A referral code is required to select a team position."
      });

    }

    // ---------------------------------
    // CHECK EXISTING ACCOUNT
    // ---------------------------------

    const existing = await User.findOne({
      $or: [
        { email: normalizedEmail },
        { mobile: normalizedMobile }
      ]
    }).select("_id");

    if (existing) {
      return res.status(409).render("auth/register", {
        title: "Register",
        error: "Email or mobile number already registered."
      });
    }

    // ---------------------------------
    // HASH PASSWORD
    // ---------------------------------

    const passwordHash = await bcrypt.hash(
      normalizedPassword,
      12
    );

    // ---------------------------------
    // GENERATE MEMBER DETAILS
    // ---------------------------------

    const memberCode = generateCode("HE");
    const newReferralCode = generateCode("REF");
    const newUserId = new mongoose.Types.ObjectId();

    // ---------------------------------
    // CREATE MEMBER DATA
    // ---------------------------------

    const userData = {
      _id: newUserId,

      memberCode,
      referralCode: newReferralCode,

      name: normalizedName,
      email: normalizedEmail,
      mobile: normalizedMobile,

      passwordHash,

      role: "member",
      status: "pending_activation",

      activation: {
        isActivated: false,
        activatedAt: null,
        activationFee: null,
        activationCurrency: "USDT",
        transactionId: null
      },

      sponsorId: null,
      placementParentId: null,
      placementSide: null,
      position: null,

      leftChildId: null,
      rightChildId: null
    };

    let user;
    let sponsor = null;
    let placement = null;

    // =================================
    // DIRECT REGISTRATION
    // NO SPONSOR / NO BINARY POSITION
    // =================================

    if (!normalizedReferralCode) {

      user = await User.create(userData);

    }

    // =================================
    // SPONSORED REGISTRATION
    // AUTOMATIC BINARY PLACEMENT
    // =================================

    else {

      // -----------------------------
      // FIND AND VALIDATE SPONSOR
      // -----------------------------

      sponsor = await User.findOne({
        referralCode: normalizedReferralCode,
        role: "member",
        status: {
          $in: [
            "active",
            "pending_activation"
          ]
        }
      }).select("_id memberCode");

      if (!sponsor) {
        throw registrationError(
          "Invalid referral code or sponsor is not eligible to refer members.",
          "INVALID_REFERRAL"
        );
      }

      // -----------------------------
      // RESERVE BINARY POSITION
      // -----------------------------

      placement = await reservePlacement(
        sponsor._id,
        normalizedPlacementSide,
        newUserId
      );

      // -----------------------------
      // SET SPONSOR RELATIONSHIP
      // -----------------------------

      userData.sponsorId = sponsor._id;

      // -----------------------------
      // SET BINARY PLACEMENT
      // -----------------------------

      userData.placementParentId = placement.parentId;
      userData.position = placement.position;
      userData.placementSide = normalizedPlacementSide;

      // -----------------------------
      // CREATE MEMBER
      // -----------------------------

      try {

        user = await User.create(userData);

      } catch (createError) {

        // Release reserved position if member creation fails

        await releasePlacement(
          placement,
          newUserId
        );

        throw createError;

      }

    }

    // =================================
    // REGISTRATION LOG
    // =================================

    console.log("\n========== NEW MEMBER REGISTERED ==========");

    console.log("Member Code:", user.memberCode);
    console.log("Referral Code:", user.referralCode);
    console.log("Status:", user.status);

    console.log(
      "Sponsor:",
      sponsor ? sponsor.memberCode : "Direct Registration"
    );

    console.log(
      "Selected Team:",
      normalizedPlacementSide || "Not applicable"
    );

    console.log(
      "Placement Parent:",
      placement ? placement.parentId : "None"
    );

    console.log(
      "Actual Position:",
      placement ? placement.position : "None"
    );

    console.log("===========================================\n");

    // =================================
    // CREATE SECURE SESSION
    // =================================

    req.session.regenerate((err) => {

      if (err) {
        console.error("Session regeneration error:", err);
        return next(err);
      }

      req.session.userId = user._id.toString();

      req.session.save((saveError) => {

        if (saveError) {
          console.error("Session save error:", saveError);
          return next(saveError);
        }

        return res.redirect("/dashboard");

      });

    });

  } catch (error) {

    console.error("\n========== REGISTRATION ERROR ==========");
    console.error("Message:", error.message);
    console.error("Name:", error.name);
    console.error("Code:", error.code);
    console.error("Details:", error);
    console.error("Stack:", error.stack);
    console.error("========================================\n");

    // ---------------------------------
    // INVALID REFERRAL
    // ---------------------------------

    if (error.registrationCode === "INVALID_REFERRAL") {
      return res.status(400).render("auth/register", {
        title: "Register",
        error: error.message
      });
    }

    // ---------------------------------
    // PLACEMENT CONFLICT
    // ---------------------------------

    if (error.registrationCode === "PLACEMENT_CONFLICT") {
      return res.status(409).render("auth/register", {
        title: "Register",
        error: error.message
      });
    }

    // ---------------------------------
    // DUPLICATE DATABASE VALUES
    // ---------------------------------

    if (error.code === 11000) {

      let message = "Account information already exists. Please try again.";

      if (error.keyPattern?.email) {
        message = "This email address is already registered.";
      }

      else if (error.keyPattern?.mobile) {
        message = "This mobile number is already registered.";
      }

      else if (
        error.keyPattern?.memberCode ||
        error.keyPattern?.referralCode
      ) {
        message = "Please try registering again.";
      }

      else if (
        error.keyPattern?.placementParentId ||
        error.keyPattern?.position
      ) {
        message = "Team placement conflict. Please try registering again.";
      }

      return res.status(409).render("auth/register", {
        title: "Register",
        error: message
      });
    }

    next(error);

  }

};

// =====================================
// LOGIN
// =====================================

exports.login = async (req, res, next) => {

  try {

    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();

    const password = String(req.body.password || "");

    // ---------------------------------
    // VALIDATE INPUT
    // ---------------------------------

    if (!email || !password) {
      return res.status(400).render("auth/login", {
        title: "Login",
        error: "Please enter your email and password."
      });
    }

    // ---------------------------------
    // FIND MEMBER
    // ---------------------------------

    const user = await User.findOne({
      email
    }).select("+passwordHash");

    if (!user) {
      return res.status(401).render("auth/login", {
        title: "Login",
        error: "Invalid email or password."
      });
    }

    // ---------------------------------
    // CHECK SUSPENDED ACCOUNT
    // ---------------------------------

    if (user.status === "suspended") {
      return res.status(403).render("auth/login", {
        title: "Login",
        error: "Your account has been suspended. Please contact support."
      });
    }

    // ---------------------------------
    // VERIFY PASSWORD
    // ---------------------------------

    const validPassword = await bcrypt.compare(
      password,
      user.passwordHash
    );

    if (!validPassword) {
      return res.status(401).render("auth/login", {
        title: "Login",
        error: "Invalid email or password."
      });
    }

    // ---------------------------------
    // ALLOW VALID MEMBER STATUSES
    // ---------------------------------

    if (
      !["active", "pending_activation"].includes(user.status)
    ) {
      return res.status(403).render("auth/login", {
        title: "Login",
        error: "Your account is not currently available."
      });
    }

    // ---------------------------------
    // PREVENT SESSION FIXATION
    // ---------------------------------

    req.session.regenerate((err) => {

      if (err) {
        console.error("Login session error:", err);
        return next(err);
      }

      req.session.userId = user._id.toString();

      req.session.save((saveError) => {

        if (saveError) {
          console.error("Login session save error:", saveError);
          return next(saveError);
        }

        return res.redirect("/dashboard");

      });

    });

  } catch (error) {

    console.error("LOGIN ERROR:", error);

    next(error);

  }

};

// =====================================
// LOGOUT
// =====================================

exports.logout = (req, res, next) => {

  if (!req.session) {
    return res.redirect("/login");
  }

  req.session.destroy((err) => {

    if (err) {
      console.error("Logout error:", err);
      return next(err);
    }

    res.clearCookie("hybrid.sid");

    return res.redirect("/login");

  });

};
