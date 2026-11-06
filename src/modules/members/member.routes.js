
const express = require("express");
const router = express.Router();

const User = require("../../models/User");

const {
  requireAuth
} = require("../../middleware/auth.middleware");


// =====================================
// MEMBER DASHBOARD
// =====================================

router.get("/dashboard", requireAuth, async (req, res, next) => {

  try {

    // Fetch member with sponsor and placement parent details
    const user = await User.findById(req.user._id)
      .populate({
        path: "sponsorId",
        select: "name memberCode referralCode"
      })
      .populate({
        path: "placementParentId",
        select: "name memberCode"
      });

    // Member no longer exists
    if (!user) {
      return res.redirect("/login");
    }

    // Render dashboard
    res.render("member/dashboard", {
      title: "Member Dashboard",
      user
    });

  } catch (error) {

    next(error);

  }

});


module.exports = router;
