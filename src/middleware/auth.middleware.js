
const User = require("../models/User");

// =====================================
// REQUIRE AUTHENTICATION
// =====================================

exports.requireAuth = async (req, res, next) => {
  try {
    // Check login session
    if (!req.session || !req.session.userId) {
      return res.redirect("/login");
    }

    // Find logged-in user
    const user = await User.findById(req.session.userId);

    // Invalid or deleted user
    if (!user) {
      req.session.destroy(() => {});
      return res.redirect("/login");
    }

    // Suspended accounts cannot access the application
    if (user.status === "suspended") {
      req.session.destroy(() => {});

      return res.status(403).render("auth/login", {
        title: "Login",
        error: "Your account has been suspended. Please contact support."
      });
    }

    // Only permitted account statuses
    if (
      !["pending_activation", "active"].includes(user.status)
    ) {
      req.session.destroy(() => {});
      return res.redirect("/login");
    }

    // Attach user to request
    req.user = user;

    // Make user available in EJS views
    res.locals.currentUser = user;

    // Convenient activation status for EJS
    res.locals.isMemberActive = user.status === "active";
    res.locals.isPendingActivation =
      user.status === "pending_activation";

    next();

  } catch (error) {
    next(error);
  }
};


// =====================================
// REQUIRE ACTIVE MEMBER
// =====================================

exports.requireActiveMember = async (req, res, next) => {
  try {
    // First authenticate the member
    if (!req.user) {
      return res.redirect("/login");
    }

    // Pending members cannot access active-member features
    if (req.user.status !== "active") {
      return res.status(403).render("member/activation-required", {
        title: "Activation Required",
        user: req.user,
        error: "Please activate your account to access this feature."
      });
    }

    next();

  } catch (error) {
    next(error);
  }
};


// =====================================
// REDIRECT AUTHENTICATED USERS
// =====================================

exports.redirectIfAuthenticated = async (req, res, next) => {
  try {
    if (!req.session || !req.session.userId) {
      return next();
    }

    const user = await User.findById(req.session.userId);

    // Invalid or suspended session
    if (!user || user.status === "suspended") {
      req.session.destroy(() => {});
      return next();
    }

    return res.redirect("/dashboard");

  } catch (error) {
    next(error);
  }
};
