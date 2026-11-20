package managementops

import "math"

// usageCostSum implements Kahan-Babuska-Neumaier compensated float64 summation,
// matching SQLite's SUM() step to avoid plain += rounding drift across large
// canonical row counts and unordered map aggregation.
type usageCostSum struct {
	sum        float64
	correction float64
}

func (c *usageCostSum) add(value float64) {
	s := c.sum
	t := s + value
	if !math.IsInf(t, 0) {
		if math.Abs(s) >= math.Abs(value) {
			c.correction += (s - t) + value
		} else {
			c.correction += (value - t) + s
		}
	}
	c.sum = t
}

// addSum folds both the primary sum and low-order error correction of another
// usageCostSum across hierarchical stages (hour -> panel) without collapsing
// early to a single 53-bit float64.
func (c *usageCostSum) addSum(other usageCostSum) {
	c.add(other.sum)
	if other.correction != 0 {
		c.add(other.correction)
	}
}

func (c usageCostSum) value() float64 {
	return c.sum + c.correction
}
