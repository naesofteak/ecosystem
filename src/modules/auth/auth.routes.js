
const express = require("express");
const router = express.Router();

const authController = require("./auth.controller");

const {
  redirectIfAuthenticated
} = require("../../middleware/auth.middleware");


// =====================================
// REGISTRATION
// =====================================

router.get(
  "/register",
  redirectIfAuthenticated,
  (req, res) => {
    res.render("auth/register", {
      title: "Register",
      error: null
    });
  }
);

router.post(
  "/register",
  redirectIfAuthenticated,
  authController.register
);


// =====================================
// LOGIN
// =====================================

router.get(
  "/login",
  redirectIfAuthenticated,
  (req, res) => {
    res.render("auth/login", {
      title: "Login",
      error: null
    });
  }
);

router.post(
  "/login",
  redirectIfAuthenticated,
  authController.login
);


// =====================================
// LOGOUT
// =====================================

router.post(
  "/logout",
  authController.logout
);


module.exports = router;
